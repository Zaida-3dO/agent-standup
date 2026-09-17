// The plumbing the reference-row endpoints repeat — `repos`, `areas`,
// `people`, `machines`, `accounts` (SCHEMA.md §19, MILESTONES.md #92, #96).
//
// These ten route files are the most uniform group in the adapter: each is a
// thin shell that authenticates, reads an id or a body, calls exactly one
// service operation, and renders. The shells were written separately and
// drifted into being identical, which means a fix to one had to be
// remembered ten times.
//
// ── What is shared here, and what deliberately is NOT ──────────────────
//
// **Shared:** the `DELETE` body/query coalescing, which is twelve lines of
// real logic plus a twelve-line comment explaining it, repeated verbatim in
// three files. It was byte-identical in all three, verified before folding.
//
// **NOT shared: the service call itself, and the method exports.** Every
// route keeps its own literal call expression naming its operation, and its
// own `export async function GET/POST/PATCH/DELETE`. That is a hard
// constraint rather than a stylistic preference:
//
//   1. `tests/adapter-conformance.test.ts` decides which operations the web
//      API serves by scanning `route.ts` files for a literal call naming the
//      operation. An operation whose call site moves into a helper becomes
//      invisible to that scan and is reported as reachable on no adapter at
//      all — stranded — which fails two separate suites.
//   2. `scripts/generate-http-routes.mjs` reads a route's methods from its
//      exported function names, and THROWS on a `route.ts` that exports none
//      it recognises. A file that re-exported its handlers from a factory
//      (`export const { GET, PATCH } = makeRoutes()`) would fail the build,
//      because destructuring is invisible to that scanner by design.
//
// So the rule for anything added here: share the plumbing AROUND the call,
// never the call. A helper that would end up making the call itself belongs
// in the route file instead.
//
// `tests/http-shared-plumbing.test.ts` enforces both halves per file, and
// also asserts this module makes no service call — which is why the prose
// above describes one rather than spelling it.
import { NextResponse } from "next/server";
import { invalidJsonResponse } from "./respond";
import { parseBooleanParam } from "./query";
import {
  authenticatedCaller,
  serviceErrorResponse,
  readJsonBody,
  withRequestId,
} from "../admin-respond";

/**
 * What a reference-row handler needs in order to make its one service call.
 *
 * `caller` is who the request authenticated as; `input` is the operation
 * input assembled from the path and, on a write, the parsed body. A handler
 * receives this and does exactly one thing with it: makes its own service
 * call, naming its operation, with these two values.
 */
export interface ReferenceRowCall {
  /**
   * Extracted from `authenticatedCaller`'s own return type rather than
   * restated, so widening what a caller carries reaches these ten routes
   * without a second declaration having to be remembered.
   */
  readonly caller: Extract<ReturnType<typeof authenticatedCaller>, { ok: true }>["caller"];
  readonly input: Record<string, unknown>;
}

/**
 * Runs the shell every reference-row handler repeats, around the two things
 * it must keep for itself.
 *
 * ── What the shell is ───────────────────────────────────────────────────
 *
 * Await the route's path parameters and map them onto operation input
 * fields. On a write, parse the body and return the 400 envelope if it is
 * not JSON. Run the caller's one call. Render the result, wrapped under a
 * key or whole. Map any thrown value onto the error envelope with the mapped
 * status and the request id.
 *
 * That was written out ten times — measured at 98.1% identical between
 * `repos/[id]` and `areas/[id]` after normalising the entity word, including
 * a twelve-line comment reproduced verbatim, and 98.7% between the
 * `accounts` and `machines` collection routes.
 *
 * ── The TWO things a route keeps, and why neither may move ──────────────
 *
 * **1. The service call.** The operation name is not passed in. This
 * function never sees it and could not make the call if it wanted to: the
 * handler passes a closure, so the literal call naming `get_repo` stays in
 * `repos/[id]/route.ts`. `tests/adapter-conformance.test.ts` decides which
 * operations the web API serves by scanning for that literal text, and an
 * operation whose call site moved in here would be reported as reachable on
 * no adapter at all. Adding an `operation` parameter is the single change
 * that would strand ten operations at once, silently — the routes would
 * keep working.
 *
 * **2. The authentication gate.** The caller is passed IN, already proven.
 * This function does not authenticate and must never start:
 * `tests/auth-route-coverage.test.ts` requires every route file to contain
 * `authenticatedCaller(request)` and to return its refusal, and then
 * requires that gate to appear before the file's first service call. It says
 * why in its own header — a test that checked three routes by hand would go
 * green for a fourth that authenticated nothing, and the gap is never in the
 * route somebody was thinking about. A gate satisfied by "a helper I import
 * does it" cannot tell an authenticated route from one that forgot, which is
 * the entire property being proved.
 *
 * So the rule this module already states for the call extends to the gate:
 * share the plumbing AROUND both, never either.
 */
export async function runReferenceRow<Result>(
  request: Request,
  /** The proven caller and its request id, from the route's own gate. */
  auth: { readonly requestId: string; readonly caller: ReferenceRowCall["caller"] },
  options: {
    /** The path parameters, and which input field each one carries. */
    readonly params?: Promise<Record<string, string>>;
    readonly pathFields?: Readonly<Record<string, string>>;
    /** Whether to parse a request body into the input. */
    readonly readsBody?: boolean;
    /** Extra input assembled from the query string. */
    readonly query?: (request: Request) => Record<string, unknown>;
    /**
     * Extra input a route reads for itself, AFTER authentication.
     *
     * Ordered after the auth check deliberately, and that ordering is
     * behaviour rather than tidiness: the delete routes read a flag that can
     * arrive as an unparseable body, and an unauthenticated caller sending
     * one must be told they are unauthenticated (401) rather than that their
     * JSON is malformed (400). Reading it before authenticating would leak
     * which of the two failed to someone who has not proved who they are.
     *
     * Returns the input to merge, or the response to return instead.
     */
    readonly read?: (
      request: Request,
      requestId: string,
    ) => Promise<
      | { readonly ok: true; readonly body: Record<string, unknown> }
      | { readonly ok: false; readonly response: NextResponse }
    >;
    /** The response key to wrap the result under, or none for the whole result. */
    readonly wrapAs?: string;
    /** The HTTP status for a successful response. */
    readonly status?: number;
    /** The route's own service call. This module never makes one. */
    readonly call: (call: ReferenceRowCall) => Promise<Result>;
  },
): Promise<NextResponse> {
  const { requestId, caller } = auth;

  const input: Record<string, unknown> = {};

  if (options.readsBody === true) {
    const body = await readJsonBody(request);
    if (body === null) return invalidJsonResponse(requestId);
    Object.assign(input, body);
  }

  if (options.read) {
    const read = await options.read(request, requestId);
    if (!read.ok) return read.response;
    Object.assign(input, read.body);
  }

  if (options.query) Object.assign(input, options.query(request));

  // The path parameters go on LAST, so a body field of the same name cannot
  // override the id in the URL. The id a caller addressed is the subject of
  // the request; a body copy disagreeing with it is the copy that has to
  // lose, and every route here already ordered it this way.
  if (options.params) {
    const resolved = await options.params;
    for (const [parameter, value] of Object.entries(resolved)) {
      input[options.pathFields?.[parameter] ?? parameter] = value;
    }
  }

  try {
    const result = await options.call({ caller, input } as ReferenceRowCall);
    const payload = options.wrapAs === undefined ? result : { [options.wrapAs]: result };
    return withRequestId(
      NextResponse.json(
        payload,
        ...(options.status === undefined ? [] : [{ status: options.status }]),
      ),
      requestId,
    );
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

/**
 * Reads the `hardDelete` flag a delete route needs, from the body or the
 * query string.
 *
 * The body is optional: `hardDelete` may also arrive as a query parameter,
 * because a `DELETE` with a body is awkward from a browser and from `curl`
 * alike. **An absent flag is not defaulted to `true`** — the service refuses
 * the call without it, which is the point of requiring it, and defaulting
 * here would quietly answer a question the caller never did.
 *
 * Returns either the input to forward, or the response to return instead
 * when the body was present but unparseable.
 */
export async function readDeleteInput(
  request: Request,
  requestId?: string,
): Promise<
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly response: NextResponse;
    }
> {
  let body: Record<string, unknown> = {};
  const raw = await request.text();
  if (raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      body =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return { ok: false, response: invalidJsonResponse(requestId) };
    }
  }
  if (body.hardDelete === undefined) {
    const flag = new URL(request.url).searchParams.get("hardDelete");
    if (flag !== null) body.hardDelete = parseBooleanParam(flag);
  }
  return { ok: true, body };
}

/**
 * Reads the one query parameter the reference-row collection reads.
 *
 * `includeArchived` is compared against the literal `"true"` rather than
 * going through `parseBooleanParam`, because that is what these five routes
 * already did and changing it would widen what they accept — a behavioural
 * change wearing a refactor's clothes.
 */
export function listInput(request: Request): Record<string, unknown> {
  const includeArchived = new URL(request.url).searchParams.get("includeArchived");
  const input: Record<string, unknown> = {};
  if (includeArchived !== null) input.includeArchived = includeArchived === "true";
  return input;
}
