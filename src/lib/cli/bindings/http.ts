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
import { bindingOk, bindingRejected, type Binding, type BindingResult } from "../binding";

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
  get_item: {
    method: "GET",
    request: (input) => ({ path: `/api/items/${encodeURIComponent(String(input.id ?? ""))}` }),
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
      if (sessionId !== undefined) headers["X-Standup-Session"] = sessionId;
      if (actor !== undefined) headers["X-Standup-Actor"] = actor;

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
        return bindingRejected(rejection, message);
      }

      return bindingOk(route.unwrap(parsed));
    },
  };
}
