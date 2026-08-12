// Proves the changed-file scoping logic behind `--changed-only`
// (`scripts/lib/mutation-scope.mjs`) — split out of
// `scripts/run-mutation-tests.mjs` specifically so this is reachable from a
// test, following the same pattern as `mutation-report-guards.mjs` /
// `mutation-report-guards.test.ts`.
//
// The core regression this guards against: `src/app/api/items/[id]/route.ts`
// and five sibling Next.js dynamic-route files are named with literal `[`
// and `]` characters. Stryker treats every `--mutate` entry as a minimatch
// glob, not a literal path, so `[id]` parses as a one-character class
// (`i` or `d`) and matches nothing on this project's real file tree. A
// plain `files.join(",")`, with no escaping, produces exactly that broken
// glob silently — no error, no warning on the CLI-target path, `files.length`
// still non-zero — so a run scoped to a bracket route proves nothing about
// it while still exiting clean. `escapeMutatePattern`/`buildMutateArg`
// below are what makes that impossible: several assertions here compare
// against the exact escaped string, so an unescaped path anywhere in the
// pipeline fails a test immediately.
import { describe, expect, it } from "vitest";
import {
  escapeMutatePattern,
  buildMutateArg,
  filterChangedSourceFiles,
} from "../scripts/lib/mutation-scope.mjs";

describe("escapeMutatePattern", () => {
  it("leaves an ordinary path with no glob-magic characters unchanged", () => {
    expect(escapeMutatePattern("src/lib/areas.ts")).toBe("src/lib/areas.ts");
  });

  // The real bracket-route file this bug affects. This is the assertion
  // that catches a regression back to an unescaped `files.join(",")`: an
  // unescaped path here would leave the pattern as
  // `src/app/api/items/[id]/route.ts`, which does NOT equal the expected
  // escaped string below.
  it("escapes a Next.js dynamic-route bracket segment (`[id]`)", () => {
    expect(escapeMutatePattern("src/app/api/items/[id]/route.ts")).toBe(
      "src/app/api/items/[[]id[]]/route.ts",
    );
  });

  it("escapes a different bracket segment (`[key]`) the same way", () => {
    expect(escapeMutatePattern("src/app/api/settings/[key]/route.ts")).toBe(
      "src/app/api/settings/[[]key[]]/route.ts",
    );
  });

  it("escapes a nested bracket segment two directories deep (`[id]/complete`)", () => {
    expect(escapeMutatePattern("src/app/api/items/[id]/complete/route.ts")).toBe(
      "src/app/api/items/[[]id[]]/complete/route.ts",
    );
  });

  // Forward-looking: other minimatch-magic characters that a future route
  // could plausibly use (Next.js route groups use parentheses, e.g.
  // `(dashboard)`). The escape must not be bracket-specific, or the next
  // special character reproduces this same bug under a different name.
  it("escapes parentheses (Next.js route-group folder syntax)", () => {
    expect(escapeMutatePattern("src/app/(dashboard)/page.tsx")).toBe(
      "src/app/[(]dashboard[)]/page.tsx",
    );
  });

  it("escapes asterisks and question marks", () => {
    expect(escapeMutatePattern("src/lib/a*b?c.ts")).toBe("src/lib/a[*]b[?]c.ts");
  });

  it("leaves forward slashes (the path separator) untouched", () => {
    const escaped = escapeMutatePattern("src/app/api/items/[id]/route.ts");
    expect(escaped.split("/")).toHaveLength(6);
  });
});

describe("buildMutateArg", () => {
  it("comma-joins escaped patterns for multiple changed files", () => {
    expect(
      buildMutateArg(["src/app/api/items/[id]/route.ts", "src/app/api/settings/[key]/route.ts"]),
    ).toBe("src/app/api/items/[[]id[]]/route.ts,src/app/api/settings/[[]key[]]/route.ts");
  });

  it("passes an ordinary file through unescaped", () => {
    expect(buildMutateArg(["src/lib/areas.ts"])).toBe("src/lib/areas.ts");
  });

  it("returns an empty string for an empty file list", () => {
    expect(buildMutateArg([])).toBe("");
  });

  // `--mutate`'s own CLI parser (`createSplitter(',')` in Stryker's
  // `stryker-cli.js`) is the ONLY way multiple patterns reach Stryker on the
  // command line, and it splits on a literal comma. A path containing one
  // would silently merge with its neighbour into one broken pattern — this
  // must fail loudly instead, before ever reaching Stryker.
  it("throws when a changed file path contains a literal comma, rather than silently merging patterns", () => {
    expect(() => buildMutateArg(["src/lib/a,b.ts", "src/lib/c.ts"])).toThrow(/literal comma/);
  });
});

describe("filterChangedSourceFiles", () => {
  const allExist = () => true;

  it("keeps a TypeScript source file under src/ that exists on disk", () => {
    expect(filterChangedSourceFiles("src/lib/areas.ts\n", allExist)).toEqual(["src/lib/areas.ts"]);
  });

  it("keeps a bracket-route .tsx/.ts file under src/ unmangled", () => {
    expect(filterChangedSourceFiles("src/app/api/items/[id]/route.ts\n", allExist)).toEqual([
      "src/app/api/items/[id]/route.ts",
    ]);
  });

  it("drops files outside src/", () => {
    expect(filterChangedSourceFiles("scripts/run-mutation-tests.mjs\n", allExist)).toEqual([]);
  });

  it("drops non-.ts/.tsx files under src/", () => {
    expect(filterChangedSourceFiles("src/lib/README.md\n", allExist)).toEqual([]);
  });

  it("drops a file that does not exist on disk (e.g. deleted in this diff)", () => {
    const existsExceptDeleted = (f: string) => f !== "src/lib/deleted.ts";
    expect(
      filterChangedSourceFiles("src/lib/deleted.ts\nsrc/lib/kept.ts\n", existsExceptDeleted),
    ).toEqual(["src/lib/kept.ts"]);
  });

  it("trims whitespace and drops blank lines", () => {
    expect(filterChangedSourceFiles("  src/lib/areas.ts  \n\n\n", allExist)).toEqual([
      "src/lib/areas.ts",
    ]);
  });

  it("returns an empty array for empty diff output", () => {
    expect(filterChangedSourceFiles("", allExist)).toEqual([]);
  });
});

// End-to-end (still fully synthetic — no git, no Stryker) proof that a
// bracket route survives the whole pipeline: raw diff output -> filtering ->
// arg-building -> the exact string that would be passed to `--mutate`.
describe("bracket-route round trip: diff output -> --mutate argument", () => {
  it("a changed bracket-route file ends up correctly escaped in the final --mutate value", () => {
    const diffOutput = "src/app/api/items/[id]/route.ts\nsrc/lib/areas.ts\n";
    const changed = filterChangedSourceFiles(diffOutput, () => true);
    const mutateArg = buildMutateArg(changed);

    expect(mutateArg).toBe("src/app/api/items/[[]id[]]/route.ts,src/lib/areas.ts");
  });
});
