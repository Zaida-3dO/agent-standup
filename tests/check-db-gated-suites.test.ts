// The self-test for `scripts/check-db-gated-suites.mjs`, following the
// precedent `tests/check-external-refs.test.ts` sets: a gate is only proven
// by seeding the violation it exists to catch and watching it fire. A check
// that has only ever been observed to pass has never been run against the
// thing it is for, and is a no-op with a green tick beside it.
//
// It also asserts what a green run does **not** mean, because this script's
// claim is narrower than its name suggests: it reads source text and one
// environment variable, and never runs a test. Both limits are pinned below
// rather than left to be rediscovered.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Plain JS, deliberately: this runs as `node scripts/…` with no build step,
// so CI can gate on it before anything is compiled.
import {
  DB_URL_ENV,
  analyse,
  isDbGated,
  main,
  testFiles,
} from "../scripts/check-db-gated-suites.mjs";

const temporaries: string[] = [];

afterAll(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway tree with the given `tests/` files, as a repo root. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "db-gated-"));
  temporaries.push(root);
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body, "utf8");
  }
  return root;
}

const GATED = `
const testDatabaseUrl = process.env.${DB_URL_ENV};
const describeIfDb = testDatabaseUrl ? describe : describe.skip;
describeIfDb("something", () => {});
`;

const PLAIN = `describe("something", () => { it("works", () => {}); });`;

describe("recognising the gate", () => {
  it("counts a file that reads the variable and binds a skip", () => {
    expect(isDbGated(GATED)).toBe(true);
  });

  it("does not count an ordinary test file", () => {
    expect(isDbGated(PLAIN)).toBe(false);
  });

  it("requires BOTH halves, so neither alone is mistaken for the gate", () => {
    // A file that merely reads a connection string is not gated on one, and a
    // bare `describe.skip` is an ordinary disabled test — visible in the
    // summary and skipped on purpose, which is a different thing entirely.
    // Counting either alone would inflate the number this check reports and
    // make the honest one harder to trust.
    expect(isDbGated(`const url = process.env.${DB_URL_ENV};`)).toBe(false);
    expect(isDbGated(`describe.skip("disabled on purpose", () => {});`)).toBe(false);
  });

  it("finds test files nested below the tests directory", () => {
    const root = tree({ "tests/a.test.ts": PLAIN, "tests/nested/b.test.ts": GATED });
    expect(testFiles(root).sort()).toEqual(["tests/a.test.ts", "tests/nested/b.test.ts"]);
    expect(analyse(root).gated).toEqual(["tests/nested/b.test.ts"]);
  });
});

describe("the gate fires on the seeded violation", () => {
  it("fails --require-db when the variable is absent", () => {
    // The violation this exists to catch: a job whose purpose is running the
    // database suites, running without a database. Every gated file skips,
    // the suite goes green, and nothing says which assertions were not made.
    const root = tree({ "tests/a.test.ts": GATED });
    expect(main(["--require-db"], {}, root)).toBe(1);
  });

  it("fails --require-db for a variable that is set but blank", () => {
    // A blank value gates exactly as an absent one does — the file's own
    // ternary reads `""` as falsy — so accepting it here would pass a run
    // that skips everything.
    const root = tree({ "tests/a.test.ts": GATED });
    expect(main(["--require-db"], { [DB_URL_ENV]: "   " }, root)).toBe(1);
  });

  it("passes --require-db once a database URL is present", () => {
    const root = tree({ "tests/a.test.ts": GATED });
    expect(main(["--require-db"], { [DB_URL_ENV]: "postgres://host/db" }, root)).toBe(0);
  });

  it("reports rather than fails in the default mode, with or without a database", () => {
    // The local-run mode answers "what am I not running". It must never fail,
    // or it would break every run on a machine with no Postgres — which is
    // the machine that most needs to be told.
    const root = tree({ "tests/a.test.ts": GATED });
    expect(main([], {}, root)).toBe(0);
    expect(main([], { [DB_URL_ENV]: "postgres://host/db" }, root)).toBe(0);
  });

  it("fails when it finds no test files at all, rather than reporting success", () => {
    // A check that inspected nothing and said "fine" is worse than one that
    // did not run: it puts a green tick against a claim it never tested.
    expect(main(["--require-db"], { [DB_URL_ENV]: "postgres://host/db" }, tree({}))).toBe(1);
    expect(main([], {}, tree({}))).toBe(1);
  });
});

describe("what a green run does NOT mean", () => {
  it("certifies only the shapes it was taught, so a differently-spelled gate is invisible", () => {
    // The same limit `check-external-refs.mjs` states about itself: a fixed
    // set of known shapes can only certify the absence of those shapes. A
    // file inventing its own gate is not counted, and widening the intent
    // without widening the pattern would not change that.
    const invented = `const runIt = process.env.SOME_OTHER_DB ? describe : describe.skip;`;
    expect(isDbGated(invented)).toBe(false);
  });

  it("proves a URL was offered, never that a database answered on it", () => {
    // A URL pointing at a closed port satisfies this check and fails the
    // suite — which is the right order for those two to fail in, but it means
    // green here is not a claim about reachability.
    const root = tree({ "tests/a.test.ts": GATED });
    expect(main(["--require-db"], { [DB_URL_ENV]: "postgres://127.0.0.1:1/nothing" }, root)).toBe(
      0,
    );
  });
});

describe("the real tree", () => {
  it("finds the gated files this repository actually has", () => {
    // Guards against the check silently matching nothing here — the failure
    // mode where the pattern still works on a fixture but has drifted from
    // how the suite really writes the gate.
    const { all, gated } = analyse();
    expect(all.length).toBeGreaterThan(0);
    expect(gated.length).toBeGreaterThan(0);
    expect(gated).toContain("tests/hook-route.test.ts");
  });
});
