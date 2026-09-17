// The generated CLI route map, against the route tree it claims to describe.
//
// ── Why this file exists ──────────────────────────────────────────────
//
// `scripts/generate-cli-routes.mjs` reads three facts off each route —
// method, path, and which input field carries each path parameter — and
// takes a fourth, the unwrap key, from a hand-written declaration. The
// generator explains why that fourth one is declared rather than inferred:
// a route's success response is an expression, and reading it with a regex
// produced confidently-wrong output in two measured ways (a multi-key
// envelope read as its first key, and a nested brace defeating a flat
// matcher).
//
// **A declaration is exactly the thing that can be wrong, so it is the
// thing that needs a test.** This is not hypothetical: `request_review` was
// declared as `reviewRequest` on the first pass, where the route actually
// answers `{ event }`, and `assertUnwrapCoverage` could not see it —
// coverage checks that every operation HAS a declaration, not that the
// declaration is right. `tests/cli-artifact-verbs.test.ts` caught that one.
// This file generalises that catch to every operation rather than the three
// that happen to have bespoke suites.
//
// ── What each assertion below can actually fail on ────────────────────
//
// Every one is checked against the route tree read independently here, so
// none of them is the generator agreeing with itself:
//
//   - a declared unwrap key naming a response key the route does not emit
//   - a path parameter that no input field carries, which would send the id
//     in the body and leave the path with a literal `{id}` in it
//   - a `GET` marked as carrying a body
//   - an operation reachable over HTTP but absent from the map
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GENERATED_ROUTES } from "@/lib/cli/bindings/cli-routes.generated";

const API_ROOT = path.join(process.cwd(), "src", "app", "api");

/** Every `route.ts` under the API tree. Walked here rather than imported. */
function routeFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...routeFiles(full));
    else if (entry === "route.ts") found.push(full);
  }
  return found;
}

/** The source of the route serving one operation, found by its call site. */
function sourceServing(operation: string): string | undefined {
  for (const file of routeFiles(API_ROOT)) {
    const source = readFileSync(file, "utf8");
    if (new RegExp(`service\\.call\\(\\s*"${operation}"`).test(source)) return source;
  }
  return undefined;
}

const operations = Object.keys(GENERATED_ROUTES).sort();

describe("the generated CLI route map", () => {
  it("covers every operation the web API serves", () => {
    // Read independently of the generator: a route file mentioning an
    // operation that the map does not carry means the binding cannot reach
    // it, which is the `not_implemented` failure this map exists to prevent.
    const served = new Set<string>();
    for (const file of routeFiles(API_ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/service\.call\(\s*"([a-z_]+)"/g)) served.add(match[1]!);
    }
    expect([...served].sort()).toEqual(operations);
  });

  it("is not empty", () => {
    // The three iterating tests below pass vacuously over an empty map, and
    // an import that silently resolved to `{}` would satisfy them all.
    expect(operations.length).toBeGreaterThan(50);
  });

  it.each(operations)("%s binds every path parameter to an input field", (operation) => {
    const route = GENERATED_ROUTES[operation]!;
    const parameters = [...route.path.matchAll(/\{(\w+?)(?:\.\.\.)?\}/g)].map((match) => match[1]!);
    // An unbound parameter is not cosmetic: the path would go out with a
    // literal `{id}` in it and the id would travel in the body, where a
    // `.strict()` schema refuses it under a name the caller never typed.
    expect(Object.keys(route.pathFields).sort()).toEqual([...parameters].sort());
  });

  /**
   * Operations whose wrapper comes from the OPERATION's own result, not from
   * the route's response expression.
   *
   * `complete_item`'s result type is `{ item }` and its route passes that
   * through plainly (`NextResponse.json(result)`), so the response body is
   * `{ item }` and the key is real — but the word `item` never appears in
   * the route's own source. Listed by name, with the reason, rather than
   * loosening the assertion for all 93: an exemption that has to be written
   * down is one a reader can check, and a weakened regex is not.
   *
   * These are still covered — `tests/cli-item-verbs.test.ts` exercises
   * `complete_item` through the binding end to end.
   */
  const WRAPPED_BY_THE_OPERATION = new Set(["complete_item"]);

  it.each(operations)("%s declares an unwrap key its route actually emits", (operation) => {
    const route = GENERATED_ROUTES[operation]!;
    if (route.unwrapKey === null || WRAPPED_BY_THE_OPERATION.has(operation)) return;
    const source = sourceServing(operation);
    expect(source, `no route.ts calls ${operation}`).toBeDefined();
    // The key must appear in the route that serves it, as either the
    // response property it wraps the result in (`NextResponse.json({ repo })`)
    // or the `wrapAs` the shared shell renders it under. Deliberately a
    // weak-but-independent check: it reads the route source rather than the
    // generator's own parse, so it fails on the `reviewRequest`/`event`
    // class of mistake — a declared key the route never emits — without
    // re-implementing the response parsing the generator refuses to do.
    const emitted =
      new RegExp(`\\b${route.unwrapKey}\\s*[:,}]`).test(source!) ||
      new RegExp(`wrapAs:\\s*"${route.unwrapKey}"`).test(source!);
    expect(
      emitted,
      `${operation} declares unwrapKey "${route.unwrapKey}", which its route never emits`,
    ).toBe(true);
  });

  it.each(operations.filter((operation) => GENERATED_ROUTES[operation]!.method === "GET"))(
    "%s is a GET and therefore carries no body",
    (operation) => {
      // A GET with a body is not something every intermediary preserves, and
      // the routes assemble a read's input from the query string. Marking one
      // as body-carrying would send its fields where the route never looks.
      expect(GENERATED_ROUTES[operation]!.sendsBody).toBe(false);
    },
  );
});
