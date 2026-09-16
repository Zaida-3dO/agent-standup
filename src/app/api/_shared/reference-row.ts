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
import { invalidJsonResponse } from "./respond";
import { parseBooleanParam } from "./query";
import type { NextResponse } from "next/server";

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
