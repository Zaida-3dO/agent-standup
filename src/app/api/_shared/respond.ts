// Shared HTTP-adapter error-to-status mapping (SCHEMA.md §22: "the service
// never knows an HTTP status exists" — that means this mapping belongs in
// the adapter, never in the service layer).
//
// A near-duplicate of `src/app/api/items/respond.ts` (row #26), kept
// separate rather than imported across directories: `items/respond.ts` is
// that row's own file, and reaching into it from `claims/`/`checkpoints/`
// would couple two independently-owned routes to one file neither owns
// outright. Both copies key the same mapping off `ServiceError.code`, so
// they cannot disagree about what one code means — only about which routes
// happen to import which copy.
import { NextResponse } from "next/server";
import { log } from "@/lib/log";
import { toServiceError, type ServiceErrorCode } from "@/lib/service";
import { REQUEST_ID_HEADER, requestIdForHttpRequest } from "@/lib/request-id-header";
import { authenticate } from "@/lib/auth";

const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  guard_rejected: 422,
  conflict: 409,
  forbidden: 403,
  not_implemented: 501,
  internal: 500,
};

/**
 * The structured extras a refusal carries, when it has any.
 *
 * `toRejection()` is deliberately the *comparable* part of a refusal — what
 * the adapter conformance suite asserts is identical across adapters — and
 * `details` is excluded from it by construction. That exclusion is right for
 * conformance and wrong for the client: a `conflict` that knows the item's
 * actual current state would render as a 409 that does not say what it is,
 * leaving the one fact the caller needs in order to retry parseable only out
 * of prose.
 *
 * So `details` is spread alongside the rejection rather than into it: the
 * comparable shape is untouched, and every existing envelope key keeps its
 * meaning. `ServiceErrorOptions.details` is documented as never containing
 * credentials, which is what makes it renderable at all.
 */
function detailsOf(error: { readonly details?: Readonly<Record<string, unknown>> }) {
  return error.details === undefined ? {} : { details: error.details };
}

/**
 * Renders any thrown value as the JSON error envelope this adapter uses, with
 * the mapped status.
 *
 * **An `internal` is logged here, with its cause.** `InternalError` keeps the
 * original on `.cause` "for exactly that reader" — the operator reading the
 * logs — but nothing used to write it anywhere, so a 500 reached the client as
 * `{"code":"internal"}` and left an empty server log behind it. The redaction
 * boundary is unchanged: the client still learns nothing it did not before.
 *
 * Only `internal` is logged, and deliberately. Every other code is a refusal
 * the caller caused and the response already explains — a 404 or a rejected
 * guard is the system working, and logging those at error level would bury the
 * one code that means something is actually wrong.
 */
export function serviceErrorResponse(error: unknown, requestId?: string): NextResponse {
  const serviceError = toServiceError(error);
  const status = STATUS_BY_CODE[serviceError.code];
  const rejection = serviceError.toRejection();
  if (serviceError.code === "internal") {
    log.error("Request failed unexpectedly.", {
      transport: "http",
      ...(requestId === undefined ? {} : { requestId }),
      err: serviceError,
    });
  }
  return withRequestId(
    NextResponse.json(
      { error: { message: serviceError.message, ...rejection, ...detailsOf(serviceError) } },
      { status },
    ),
    requestId,
  );
}

/**
 * The request id to use for one inbound HTTP call, and the caller context to
 * hand `service.call`.
 *
 * Every route resolves this once, at the top, and then uses the same value
 * for the service call and for the response — which is the whole point:
 * an id echoed to the caller that was not the id the service logged would
 * be worse than not echoing one, because it would name a call that does not
 * appear anywhere in the log.
 *
 * `transport` is stamped here rather than being repeated at every call site
 * for the same reason: it is a fact about *how the call arrived*, and this
 * is the one module that knows a call arrived over HTTP.
 */
export function httpCaller(request: Request): {
  readonly requestId: string;
  readonly caller: { readonly transport: string; readonly requestId: string };
} {
  const requestId = requestIdForHttpRequest(request.headers.get(REQUEST_ID_HEADER));
  return { requestId, caller: { transport: "http", requestId } };
}

/**
 * Stamps the served request id onto a response.
 *
 * Applied to every response a route produces — a success, a refusal and a
 * 500 alike — because "I called X and got Y" is asked about all three, and
 * an id present only on failures is missing precisely when someone is
 * trying to report that a *successful* call returned the wrong thing.
 *
 * Tolerates an absent id so a route that has not resolved one (a malformed
 * body rejected before anything else happens) still returns a well-formed
 * response rather than a header reading `undefined`.
 */
export function withRequestId(response: NextResponse, requestId?: string): NextResponse {
  if (requestId !== undefined) response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

/**
 * Renders a malformed-JSON body as the same 400 envelope every route uses for it.
 *
 * Carries the request id like every other response: a caller whose body was
 * rejected is exactly the one likely to be asking why, and an id is the
 * thing that finds the attempt in the log.
 */
export function invalidJsonResponse(requestId?: string): NextResponse {
  return withRequestId(
    NextResponse.json(
      { error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] } },
      { status: 400 },
    ),
    requestId,
  );
}

/**
 * `AppendedEvent` (src/lib/events.ts) carries `id` and `txId` as `bigint` —
 * chosen there because Postgres's `xid8`/`bigserial` values do not fit
 * `number` without precision loss at realistic table sizes. `JSON.stringify`
 * (which `NextResponse.json` calls internally) throws on a raw `bigint`
 * rather than silently truncating it, so every route returning one of these
 * must convert first. Stringified rather than left numeric: a `bigint`
 * serialised as a JSON number would round-trip through a JS client's
 * `JSON.parse` as an imprecise `number`, the exact loss the `bigint` type
 * exists to avoid — the string form is what every consumer here has to
 * parse deliberately instead of losing precision by default.
 */
export function serializeAppendedEvent(event: {
  readonly id: bigint;
  readonly txId: bigint;
  readonly ts: Date;
}): { id: string; txId: string; ts: string } {
  return { id: String(event.id), txId: String(event.txId), ts: event.ts.toISOString() };
}

/**
 * The 401 every route returns for a request that did not authenticate.
 *
 * **The body says which of the two failures it was, and nothing more.** A
 * caller that sent no credential is told to send one; a caller that sent a
 * bad one is told it was not recognised. Neither message names a machine,
 * confirms that a machine exists, or says anything about how many tokens
 * are configured — the refusal is a fact about this request, not a readable
 * description of the installation's configuration.
 *
 * `WWW-Authenticate` is set because the status is defined in terms of it:
 * a 401 without it tells a client it may retry but not with what, and the
 * header is the one machine-readable part of this response that a generic
 * HTTP client already knows how to act on.
 *
 * The code is `forbidden` rather than a new member of the taxonomy. The
 * taxonomy is the *service layer's* vocabulary and authentication happens
 * before any service call — but a client parsing the envelope should not
 * have to learn a code that appears on no operation, and "you may not do
 * this" is what both mean. The status carries the distinction that matters:
 * `forbidden` from an operation is a 403, this is a 401.
 */
export function unauthenticatedResponse(
  reason: "missing" | "invalid",
  requestId?: string,
): NextResponse {
  const message =
    reason === "missing"
      ? "This request needs a bearer token. Send it as `Authorization: Bearer <token>`."
      : "The bearer token presented was not recognised.";
  const response = NextResponse.json(
    { error: { code: "forbidden", message, fields: [] } },
    { status: 401 },
  );
  response.headers.set("WWW-Authenticate", 'Bearer realm="standup"');
  return withRequestId(response, requestId);
}

/**
 * The authenticated equivalent of `httpCaller` — the one gate every routed
 * request passes.
 *
 * **Why the gate lives here rather than in each route.** There are dozens
 * of routes and there will be more, and a check written per-route is a
 * check a new route forgets. Every route already calls this module to
 * resolve its request id and caller, so putting authentication in the same
 * call makes "was this request authenticated" inseparable from "who is
 * calling" — a route physically cannot obtain a caller without having
 * passed the gate, because the caller is what the gate returns.
 *
 * Returns a discriminated union rather than throwing. A throw would be
 * caught by the `catch` every route already wraps its service call in, and
 * rendered by `serviceErrorResponse` as whatever the taxonomy mapped it to
 * — turning a deliberate 401 into a 500 or a 403 depending on which error
 * class it was dressed as. A union forces the route to return the refusal
 * it was handed, unchanged.
 *
 * **The authenticated machine name is what makes the actor header
 * trustworthy.** The actor a caller declares is a self-report; the machine
 * resolved from a token is not. Carrying both lets a write record who the
 * caller said it was alongside the machine the server proved it came from.
 */
export function authenticatedCaller(request: Request):
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly caller: {
        readonly transport: string;
        readonly requestId: string;
        readonly machine: string;
      };
    }
  | { readonly ok: false; readonly response: NextResponse } {
  const { requestId } = httpCaller(request);
  const result = authenticate(request);

  if (!result.ok) {
    // Logged at `warn`: a refused call is not the server failing, but it is
    // the thing an operator rolling out tokens needs to see — a machine
    // that has not been configured yet produces a steady trickle of these
    // and nothing else anywhere would say so. The token is never logged,
    // in either form: a rejected credential is still a credential, and a
    // log is a place secrets outlive the request that carried them.
    log.warn("Refused an unauthenticated request.", {
      transport: "http",
      requestId,
      reason: result.reason,
    });
    return { ok: false, response: unauthenticatedResponse(result.reason, requestId) };
  }

  return {
    ok: true,
    requestId,
    caller: { transport: "http", requestId, machine: result.machine.machine },
  };
}
