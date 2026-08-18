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
import { SERVICE_ERROR_CODES } from "@/lib/service";
import { log, newRequestId } from "@/lib/log";
import { bindingOk, bindingRejected, type Binding, type BindingResult } from "../binding";
import { ADMIN_HTTP_ROUTES } from "./http-routes-admin";
import { OWNERSHIP_HTTP_ROUTES } from "./http-routes-ownership";
import { BACKFILL_HTTP_ROUTES } from "./http-routes-backfill";
import { ARTIFACT_HTTP_ROUTES } from "./http-routes-artifacts"; // row #98 — artifact writes
import { LOOP_HTTP_ROUTES } from "./http-routes-loops"; // row #100 - open-loop writes
import { SESSION_HTTP_ROUTES } from "./http-routes-sessions";
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
 * Every operation the API exposes, by the name the service knows it as.
 *
 * Keyed on operation names rather than on paths so that the question this
 * binding actually has to answer — "can I reach this operation?" — is a
 * lookup, and an operation the API does not route is refused with
 * `not_implemented` naming the operation, which is a true statement about
 * this binding rather than a transport error the caller has to interpret.
 */
export const HTTP_ROUTES: Readonly<Record<string, RouteSpec>> = Object.freeze({
  create_item: {
    method: "POST",
    request: (input) => ({ path: "/api/items", body: input }),
    unwrap: (body) => property(body, "item"),
  },
  // The three explicit creates. Each posts to its own collection, so which
  // kind is being made is visible in the request rather than inferred from
  // the body — the same property the operations exist to give a caller.
  create_project: {
    method: "POST",
    request: (input) => ({ path: "/api/projects", body: input }),
    unwrap: (body) => property(body, "item"),
  },
  create_task: {
    method: "POST",
    request: (input) => ({ path: "/api/tasks", body: input }),
    unwrap: (body) => property(body, "item"),
  },
  create_subtask: {
    method: "POST",
    request: (input) => ({ path: "/api/subtasks", body: input }),
    unwrap: (body) => property(body, "item"),
  },
  get_item: {
    method: "GET",
    // `id` goes in the path; every other input — `full` (MILESTONES.md
    // #107) — goes in the query string. Without this the two
    // bindings would disagree about what `--full` does: `direct` would
    // return the whole record and `http` the slim shape, from one command
    // line. Row #85's one-interface test compares exactly that.
    request: (input) => {
      const { id, ...rest } = input;
      return {
        path: `/api/items/${encodeURIComponent(String(id ?? ""))}${queryString(rest)}`,
      };
    },
    unwrap: (body) => property(body, "item"),
  },
  update_item: {
    method: "PATCH",
    request: (input) => {
      const { id, ...rest } = input;
      return { path: `/api/items/${encodeURIComponent(String(id ?? ""))}`, body: rest };
    },
    unwrap: (body) => property(body, "item"),
  },
  list_items: {
    method: "GET",
    request: (input) => ({ path: `/api/items${queryString(input)}` }),
    unwrap: (body) => body,
  },
  // Row #105. `GET /search` returns the result object unwrapped, like every
  // other list-shaped read, so `unwrap` is the identity — the same shape
  // `direct` returns for the same call.
  search: {
    method: "GET",
    request: (input) => ({ path: `/api/search${queryString(input)}` }),
    unwrap: (body) => body,
  },
  // Row #83 — `standup config`. `src/app/api/settings/**` returns every
  // settings operation's result unwrapped already (SCHEMA.md §19), so
  // `unwrap` is the identity for all four — the same shape `direct` returns.
  get_settings: {
    method: "GET",
    request: () => ({ path: "/api/settings" }),
    unwrap: (body) => body,
  },
  get_setting: {
    method: "GET",
    request: (input) => ({
      path: `/api/settings/${encodeURIComponent(String(input.key ?? ""))}`,
    }),
    unwrap: (body) => body,
  },
  put_setting: {
    method: "PUT",
    request: (input) => {
      const { key, ...rest } = input;
      return { path: `/api/settings/${encodeURIComponent(String(key ?? ""))}`, body: rest };
    },
    unwrap: (body) => body,
  },
  delete_setting: {
    method: "DELETE",
    request: (input) => ({
      path: `/api/settings/${encodeURIComponent(String(input.key ?? ""))}`,
    }),
    unwrap: (body) => body,
  },
  transition_item: {
    method: "POST",
    request: (input) => {
      // `dryRun` travels as the `?dry_run=` query parameter the route reads
      // (SCHEMA.md §19), not in the body — mirroring how `id` above always
      // moves from the operation's flat input into the path. Only ever set
      // to `true`; the route treats anything else, including the parameter
      // being absent, as a real move.
      const { id, dryRun, ...rest } = input;
      const query = dryRun === true ? "?dry_run=true" : "";
      return {
        path: `/api/items/${encodeURIComponent(String(id ?? ""))}/transition${query}`,
        body: rest,
      };
    },
    // The route answers `{ item, outcome }` for a real move and `{ outcome }`
    // alone for a rehearsal (`transition/route.ts`'s `RehearsalRollback`
    // unwrapping) — the same two shapes the `direct` binding's own
    // rehearsal handling produces. Returning the body unchanged, rather
    // than pulling one key out the way the single-item routes above do, is
    // what keeps those two shapes identical between bindings.
    unwrap: (body) => body,
  },
  complete_item: {
    method: "POST",
    request: (input) => {
      const { id, ...rest } = input;
      return { path: `/api/items/${encodeURIComponent(String(id ?? ""))}/complete`, body: rest };
    },
    unwrap: (body) => property(body, "item"),
  },
  // MILESTONES.md #92 — repo/area/machine/account routes, kept in their own
  // module (./http-routes-admin.ts) and spread in as a single line, per
  // that module's own header, so concurrent CLI rows adding entries above
  // never conflict with this one.
  ...ADMIN_HTTP_ROUTES,
  ...OWNERSHIP_HTTP_ROUTES,
  ...BACKFILL_HTTP_ROUTES,
  ...ARTIFACT_HTTP_ROUTES, // row #98 — artifact writes
  ...LOOP_HTTP_ROUTES, // row #100 - open-loop writes
  ...SESSION_HTTP_ROUTES, // row #43 — the registration handshake
});

/** The minimal `fetch` this binding needs, so a test can supply one. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpBindingOptions {
  /** Where the server is. Trailing slashes are tolerated. */
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly sessionId?: string;
  readonly actor?: string;
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
        if (rejection.code === "internal") {
          // Either the server itself failed, or it answered with a body
          // this build does not recognise — and the second is invisible
          // from the terminal, which sees only "the server refused". The
          // status is what tells those apart, so it is logged.
          log.error("The server failed or answered unrecognisably.", {
            requestId,
            transport: "cli",
            binding: "http",
            operation,
            status: response.status,
          });
        } else {
          log.debug("The server refused the command.", {
            requestId,
            transport: "cli",
            binding: "http",
            operation,
            status: response.status,
            code: rejection.code,
            ...(rejection.guard === undefined ? {} : { guard: rejection.guard }),
          });
        }
        return bindingRejected(rejection, message);
      }

      return bindingOk(route.unwrap(parsed));
    },
  };
}
