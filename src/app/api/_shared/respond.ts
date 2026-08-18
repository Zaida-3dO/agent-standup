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
    NextResponse.json({ error: { message: serviceError.message, ...rejection } }, { status }),
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

/** Renders a malformed-JSON body as the same 400 envelope every route uses for it. */
export function invalidJsonResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] } },
    { status: 400 },
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
