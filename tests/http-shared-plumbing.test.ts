// The reference-row routes kept their call sites when their plumbing moved.
//
// `src/app/api/_shared/reference-row.ts` folds the duplicated `DELETE`
// body/query coalescing and the `includeArchived` read out of ten route
// files. That refactor has one way to go wrong, and it is silent from the
// route's own point of view: the file keeps working while becoming invisible
// to the two scanners that decide what the HTTP surface IS.
//
//   1. `tests/adapter-conformance.test.ts` finds the operations the web API
//      serves by scanning `route.ts` files for the literal text
//      `service.call("<name>"`. Move a call into a helper and the operation
//      is reported as reachable on no adapter at all.
//   2. `scripts/generate-http-routes.mjs` reads a route's methods from its
//      exported function names, and throws on a file exporting none it
//      recognises — so `export const { GET, PATCH } = makeRoutes()` fails
//      the build rather than shipping a half-listed route.
//
// **These assertions are per-file and per-operation, deliberately.** A
// tree-wide count — "the api directory still contains 82 service calls" —
// stays green while one file is wrong, because another file having two calls
// hides a file having none. Counting is exactly the shape of assertion that
// cannot see the only failure that matters here.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Each rewritten route, with the operations it must still call by name.
 *
 * Spelled out rather than derived from the files themselves. Deriving the
 * expectation from the source under test would assert only that the file
 * equals itself — if a call vanished, the derived list would shrink with it
 * and stay green. This list is what the routes are FOR, so deleting a call
 * fails here.
 */
const ROUTES: readonly {
  readonly path: string;
  readonly operations: readonly string[];
  readonly methods: readonly string[];
}[] = [
  {
    path: "repos/route.ts",
    operations: ["list_repos", "create_repo"],
    methods: ["GET", "POST"],
  },
  {
    path: "repos/[id]/route.ts",
    operations: ["get_repo", "update_repo", "delete_repo"],
    methods: ["GET", "PATCH", "DELETE"],
  },
  {
    path: "areas/route.ts",
    operations: ["list_areas", "create_area"],
    methods: ["GET", "POST"],
  },
  {
    path: "areas/[id]/route.ts",
    operations: ["get_area", "update_area", "delete_area"],
    methods: ["GET", "PATCH", "DELETE"],
  },
  {
    path: "people/route.ts",
    operations: ["list_people"],
    methods: ["GET"],
  },
  {
    path: "people/[id]/route.ts",
    operations: ["update_person", "delete_person"],
    methods: ["PATCH", "DELETE"],
  },
  {
    path: "machines/route.ts",
    operations: ["list_machines"],
    methods: ["GET"],
  },
  {
    path: "machines/[name]/route.ts",
    operations: ["get_machine", "update_machine"],
    methods: ["GET", "PATCH"],
  },
  {
    path: "accounts/route.ts",
    operations: ["list_accounts"],
    methods: ["GET"],
  },
  {
    path: "accounts/[id]/route.ts",
    operations: ["get_account", "update_account"],
    methods: ["GET", "PATCH"],
  },
];

async function sourceOf(path: string): Promise<string> {
  return readFile(join(process.cwd(), "src", "app", "api", ...path.split("/")), "utf8");
}

describe("every rewritten reference-row route keeps its own call sites", () => {
  it.each(ROUTES)(
    "$path calls each of its operations by literal name",
    async ({ path, operations }) => {
      const source = await sourceOf(path);
      for (const operation of operations) {
        // The same literal `adapter-conformance.test.ts` scans for. Asserted
        // as raw text rather than by importing the module, because text is
        // what that scanner sees — a call the module makes dynamically would
        // pass an import-based check and still strand the operation.
        expect(source, `${path} must call ${operation} by literal name`).toContain(
          `service.call("${operation}"`,
        );
      }
    },
  );

  it.each(ROUTES)(
    "$path exports each method in a form the generator recognises",
    async ({ path, methods }) => {
      const source = await sourceOf(path);
      for (const method of methods) {
        // `export async function GET(` — the declaration form. The generator
        // also recognises `export const GET =` and `export { x as GET }`, but
        // these ten files all use the declaration form and should keep doing
        // so; a change to another form is a change worth noticing.
        expect(source, `${path} must export ${method} as a function declaration`).toMatch(
          new RegExp(`export\\s+async\\s+function\\s+${method}\\s*\\(`),
        );
      }
    },
  );

  it.each(ROUTES)("$path never destructures its handlers into existence", async ({ path }) => {
    const source = await sourceOf(path);
    // The one shape that fails the build: the generator cannot see a method
    // assigned by destructuring, so a route written this way exports no
    // method it recognises and it throws.
    expect(source).not.toMatch(/export\s+const\s*\{[^}]*\b(GET|POST|PATCH|PUT|DELETE)\b/);
  });
});

describe("the shared module holds plumbing, never a service call", () => {
  it("contains no `service.call`, because a call site there is invisible to the scan", async () => {
    const source = await readFile(
      join(process.cwd(), "src", "app", "api", "_shared", "reference-row.ts"),
      "utf8",
    );
    // This is the rule that keeps the refactor safe as it grows: anything
    // added to the shared module shares the plumbing AROUND the call. The
    // moment a `service.call` lands here, whichever operation it names stops
    // being seen as HTTP-reachable.
    expect(source).not.toContain("service.call(");
  });
});
