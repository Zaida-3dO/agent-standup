// The `http` binding — the same commands, over the API (SCHEMA.md §20).
//
// "With `STANDUP_URL` set it calls the API." Its whole job is to be
// indistinguishable from `direct` at the `Binding` boundary: same operation
// names in, same `BindingResult` out, same `Rejection` for the same bad
// input. Everything below is in service of that one property.
//
// **The route map is this binding's only asymmetry, and it is contained.**
// The service layer is addressed by operation name; the API is addressed by
// method, path and body, because §19 specifies a REST-shaped surface rather
// than an RPC one. Translating between them has to happen somewhere, and
// here is the right somewhere: it is the one file that knows both, it is
// keyed on the operation registry so an operation with no route is a
// startup-time answer rather than a 404 discovered by a user, and nothing
// above it — no command, no dispatcher — ever sees a path or a status code.
import type { Rejection, ServiceErrorCode } from "@/lib/service";
import { SERVICE_ERROR_CODES, faultContext } from "@/lib/service";
import { log, newRequestId } from "@/lib/log";
import { bindingOk, bindingRejected, type Binding, type BindingResult } from "../binding";
import { GENERATED_ROUTES, type GeneratedRoute } from "./cli-routes.generated";
import { ACTOR_HEADER, CLI_TRANSPORT_HEADER, SESSION_HEADER } from "@/lib/session-transport-header";
import { REQUEST_ID_HEADER } from "@/lib/request-id-header";

/** How one operation is expressed as an HTTP request. */
export interface RouteSpec {
  // "PUT" added by row #83 for `PUT /settings/{key}` (SCHEMA.md §19) — the
  // first route this table needs it for; `create_item`/`update_item`/etc.
  // stay on the four already listed.
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /**
   * Builds the path and the body from the operation's input.
   *
   * A function rather than a template string because the split between
   * "what goes in the path" and "what goes in the body" is per-operation:
   * `get_item` puts its `id` in the path and sends nothing, `update_item`
   * puts its `id` in the path and the rest in the body, `list_items` puts
   * everything in the query string.
   */
  readonly request: (input: Record<string, unknown>) => {
    path: string;
    body?: unknown;
  };
  /**
   * Pulls the operation's result out of the response body.
   *
   * The API wraps a single item as `{ item }` and a list as the result
   * object itself; the service returns the unwrapped value in both cases.
   * Unwrapping here is what makes the two bindings' `data` comparable
   * without a caller knowing which one it used.
   */
  readonly unwrap: (body: unknown) => unknown;
}

function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

/** Reads one property off a response body without asserting its whole shape. */
function property(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null
    ? (body as Record<string, unknown>)[key]
    : undefined;
}

function queryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    // `null` is meaningful for `parentId` — §19's "top level only" filter —
    // and the route reads an empty string as exactly that, so it is sent
    // rather than dropped.
    params.set(key, value === null ? "" : String(value));
  }
  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}

/**
 * Turns one generated route into the request/unwrap pair this binding uses.
 *
 * The generated map is DATA — a method, a path template, which input field
 * each path parameter carries, whether a body is read, and which response
 * key holds the result. This is the one place that data becomes behaviour,
 * and the behaviour it produces is exactly what the 68 hand-written
 * `RouteSpec` entries produced before it: the path fields are lifted out of
 * the input and interpolated, and what remains travels as a body on a write
 * or as a query string on a read.
 *
 * **Lifting rather than copying is the point.** A path field must not also
 * appear in the body: the route merges the path value back in itself, so
 * sending it twice would mean two spellings of the same value reaching an
 * operation whose schema is `.strict()`.
 */
function specFor(route: GeneratedRoute): RouteSpec {
  return {
    method: route.method,
    request: (input) => {
      const rest = { ...input };
      let path = route.path;
      for (const [parameter, field] of Object.entries(route.pathFields)) {
        path = path.replace(`{${parameter}}`, encodeURIComponent(String(rest[field] ?? "")));
        delete rest[field];
      }
      // Fields a body-carrying route reads from the query string instead.
      // `transition_item`'s `dryRun` is the case, and it is the one field
      // where getting this wrong is expensive rather than merely wrong: sent
      // in the body the route never sees it, and a rehearsal silently
      // becomes a real move.
      //
      // **Only emitted when `true`**, matching the route, which treats
      // anything else — including the parameter being absent — as a real
      // move. Emitting `?dry_run=false` would be a second spelling of the
      // default that nothing else in the system produces.
      let query = "";
      for (const [field, parameter] of Object.entries(route.queryFields)) {
        if (rest[field] === true) query = `?${parameter}=true`;
        delete rest[field];
      }

      // Everything the path did not take. On a write it is the body; on a
      // read it is the query string, because a `GET` carries no body and
      // dropping it instead would make the two bindings disagree about what
      // a flag such as `--full` does from one command line.
      return route.sendsBody
        ? { path: `${path}${query}`, body: rest }
        : { path: `${path}${queryString(rest)}` };
    },
    unwrap:
      route.unwrapKey === null
        ? (body) => body
        : (body) => property(body, route.unwrapKey as string),
  };
}

/**
 * Every operation the API exposes, by the name the service knows it as.
 *
 * Keyed on operation names rather than on paths so that the question this
 * binding actually has to answer — "can I reach this operation?" — is a
 * lookup, and an operation the API does not route is refused with
 * `not_implemented` naming the operation, which is a true statement about
 * this binding rather than a transport error the caller has to interpret.
 *
 * **Built from the route tree, not written by hand.** This was 68 entries
 * across eight files, each restating a method, a path, a path field and an
 * unwrap key that the route serving the operation already declared — a
 * second copy that nothing compared, and that had drifted: 39 of the 68
 * spelled the identity `unwrap` out in six lines, and ten reference-row
 * reads silently dropped every input but the path id while their siblings
 * forwarded the rest. `scripts/generate-cli-routes.mjs` now reads those
 * facts from `src/app/api/**\/route.ts`, and `npm run check:cli-routes`
 * fails when the generated file and the tree disagree.
 *
 * The eight-file split went with it. `http-routes-admin.ts`'s header said
 * it existed because concurrent branches landed entries in the same table
 * and conflicted — merge-conflict avoidance that had become architecture.
 * Generating the map removes the conflict surface outright.
 */
export const HTTP_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze(
  Object.fromEntries(
    Object.entries(GENERATED_ROUTES).map(([operation, route]) => [operation, specFor(route)]),
  ),
);

/** The minimal `fetch` this binding needs, so a test can supply one. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpBindingOptions {
  /** Where the server is. Trailing slashes are tolerated. */
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly sessionId?: string;
  readonly actor?: string;
  /**
   * The bearer token to present, when the server requires one.
   *
   * Optional so that this binding still builds without it, and the server
   * answers the resulting call with a 401 that says what is missing. A
   * binding that refused to construct would turn a fixable configuration
   * problem into a crash at a point where nothing yet knows whether the
   * server even wants a token.
   */
  readonly token?: string;
}

function isServiceErrorCode(value: unknown): value is ServiceErrorCode {
  return typeof value === "string" && (SERVICE_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Reads the API's error envelope back into the service's `Rejection`.
 *
 * **Deliberately does not read the HTTP status.** The status is a
 * *projection* of the code (`respond.ts` maps one onto the other), so
 * recovering the code from the status would be lossy in the one direction
 * that matters — several codes share a status class, and §22 compares the
 * code. Reading the code the API already sent keeps the round trip exact:
 * `guard_rejected` in the service is `guard_rejected` here, with the same
 * `guard` and the same `fields`, which is what makes a rejection through
 * this binding equal to the same rejection through `direct`.
 *
 * A body that is not the expected envelope becomes `internal` — the server
 * answered with something this build does not understand, which is not the
 * caller's doing and is not a rule refusing.
 */
/**
 * The diagnosis the server attached to a failure, as log fields.
 *
 * Every field is optional and independently checked, because an older server
 * sends none of them and a body that is not the expected envelope reaches
 * here too. A missing field is simply absent from the log line rather than
 * logged as `undefined`.
 *
 * `internalKind` is **not** validated against `INTERNAL_KINDS` and does not
 * need to be: it is going to a log line, not into a decision, and the server
 * emits it from the frozen union. Copying the union here to re-check it
 * would be a second copy to keep in step for no gain.
 */
function diagnosisFromBody(body: unknown): Record<string, unknown> {
  const error = property(body, "error");
  const serverRequestId = property(error, "requestId");
  const retryable = property(error, "retryable");
  const internalKind = property(error, "internalKind");
  const committed = property(error, "committed");
  return {
    ...(typeof serverRequestId === "string" ? { serverRequestId } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
    ...(typeof internalKind === "string" ? { internalKind } : {}),
    ...(committed === undefined ? {} : { committed }),
  };
}

function rejectionFromBody(
  body: unknown,
  status: number,
): { rejection: Rejection; message: string } {
  const error = property(body, "error");
  const code = property(error, "code");
  const message = property(error, "message");
  const fields = property(error, "fields");
  const guard = property(error, "guard");

  if (!isServiceErrorCode(code)) {
    return {
      rejection: { code: "internal", fields: [] },
      message: `The server answered ${status} with a body this build does not recognise.`,
    };
  }

  return {
    rejection: {
      code,
      fields: Array.isArray(fields) ? fields.map(String) : [],
      ...(typeof guard === "string" ? { guard } : {}),
    },
    message: typeof message === "string" ? message : `The server refused with ${code}.`,
  };
}

/**
 * Builds the binding that calls the API.
 *
 * The session and actor travel as headers rather than in the body: they are
 * *who is calling*, not part of any operation's input schema, and putting
 * them in the body would make them fail that schema's `.strict()` parse —
 * the same reason the `direct` binding passes them as `caller` rather than
 * merging them into the input.
 */
export function createHttpBinding({
  baseUrl,
  fetch: fetchImpl,
  sessionId,
  actor,
  token,
}: HttpBindingOptions): Binding {
  const root = baseUrl.replace(/\/+$/, "");
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  return {
    name: "http",
    async invoke(operation: string, input: unknown): Promise<BindingResult> {
      const route = HTTP_ROUTES[operation];
      if (!route) {
        return bindingRejected(
          { code: "not_implemented", fields: ["operation"] },
          `The server does not expose ${operation} over HTTP.`,
        );
      }

      const { path, body } = route.request(asRecord(input));
      const headers: Record<string, string> = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (sessionId !== undefined) headers[SESSION_HEADER] = sessionId;
      if (actor !== undefined) headers[ACTOR_HEADER] = actor;
      // The credential, and the reason the two headers above can be
      // believed at all. A session and an actor are what this client says
      // about itself; the token is the thing the server checks, and the
      // machine it resolves to is what gives those claims an origin the
      // server established rather than accepted.
      if (token !== undefined) headers.Authorization = `Bearer ${token}`;
      // SCHEMA.md §21's five transports include `cli-http` — the command
      // line talking to a server — and from the server's side that request
      // is indistinguishable from any other HTTP call. This header is how
      // the two are told apart, and it is a *fixed literal* rather than a
      // configurable value on purpose: it says "this request came from this
      // binding", which is a fact this module is the authority on. It is not
      // trusted blindly on the far side either — the route accepts it only
      // from the one narrow set of values it can distinguish, so a caller
      // sending it by hand can at worst claim to be a command line, never
      // claim a capability the transport does not confer.
      headers[CLI_TRANSPORT_HEADER] = "cli-http";

      // This binding's id labels the lines written in this process, and —
      // because it is sent — the lines the server writes for the same call.
      // That is the whole point of sending it: without it the two processes
      // each mint their own id and write correlated lines that cannot be
      // joined, so an operator holding a client-side failure has no way to
      // find the server's account of the same call.
      //
      // Minted before the request rather than read from the response so the
      // id also labels the failures where there *is* no response — an
      // unreachable server is the case most worth correlating and the one a
      // server-assigned id could never cover.
      const requestId = newRequestId();
      headers[REQUEST_ID_HEADER] = requestId;

      let response: Response;
      try {
        response = await doFetch(`${root}${path}`, {
          method: route.method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (cause) {
        // An unreachable server is not a rule refusing, and it is not the
        // caller's input being wrong. It becomes `internal`, which exits 1
        // — "try again / something is broken" — rather than 3, which would
        // tell a script the installation had decided something.
        //
        // **The underlying error's text is deliberately not interpolated.**
        // A connect failure's message routinely carries the host, the port
        // and any credentials embedded in the URL — `connect ECONNREFUSED
        // <host>:<port>` is the common shape — and SCHEMA.md §20 says the
        // connection string "is never printed by any command". A base URL is
        // this binding's equivalent of one, so the only safe thing to render
        // is a fixed sentence plus the error's *class*, which names the
        // failure mode without carrying an address.
        //
        // **The log gets what the terminal must not.** The detail withheld
        // above — the host, the port, whatever the connect error actually
        // said — is exactly what a person diagnosing this needs, so it is
        // kept rather than dropped: `describeError` (`lib/log.ts`) renders
        // the cause and its own chain onto stderr, which is a stream a
        // person reads, not one a pipeline parses.
        log.error("Could not reach the server.", {
          requestId,
          transport: "cli",
          binding: "http",
          operation,
          method: route.method,
          // The path, not the base URL: the path is this build's own route
          // table and says which call failed, while the base URL is the
          // configured address §20 keeps out of a rendered message. In a
          // log it would be defensible; it is left out because the log line
          // does not need it to be useful and the rule is easier to keep
          // than to qualify.
          path,
          err: cause,
        });
        return bindingRejected(
          { code: "internal", fields: [] },
          `Could not reach the server (${cause instanceof Error ? cause.name : "unknown error"}). Check the configured address.`,
        );
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }

      if (!response.ok) {
        const { rejection, message } = rejectionFromBody(parsed, response.status);
        // What the server said about the failure beyond the rejection
        // itself. Read back into the log line rather than into `rejection`:
        // that type is the *comparable* part of a refusal, which §22 asserts
        // is identical across adapters, so widening it here would make this
        // binding's answer unequal to `direct`'s for the same failure.
        const diagnosis = diagnosisFromBody(parsed);
        // `faultContext` on the *code*, not on an error object: this
        // binding never holds one. The body has already been reduced to a
        // `Rejection` rebuilt from JSON, which is exactly why `faultFor`
        // exists as a free function alongside the getter.
        if (faultContext(rejection.code).fault === "server") {
          // Either the server itself failed, or it answered with a body
          // this build does not recognise — and the second is invisible
          // from the terminal, which sees only "the server refused". The
          // status is what tells those apart, so it is logged.
          //
          // The server's own request id is logged under `serverRequestId`,
          // beside this process's `requestId`. They name the same call on
          // two machines, and collapsing them into one key would make a
          // grep for either ambiguous.
          log.error("The server failed or answered unrecognisably.", {
            requestId,
            transport: "cli",
            binding: "http",
            operation,
            status: response.status,
            ...faultContext(rejection.code),
            ...diagnosis,
          });
        } else {
          log.debug("The server refused the command.", {
            requestId,
            transport: "cli",
            binding: "http",
            operation,
            status: response.status,
            code: rejection.code,
            ...faultContext(rejection.code),
            ...(rejection.guard === undefined ? {} : { guard: rejection.guard }),
          });
        }
        return bindingRejected(rejection, message);
      }

      return bindingOk(route.unwrap(parsed));
    },
  };
}
