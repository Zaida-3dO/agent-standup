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

describe("the report reads as a verdict, not as an alarm", () => {
  // ── The defect this block pins ─────────────────────────────────────────
  //
  // The skipping branch used to open with `TEST_DATABASE_URL is NOT set`.
  // That branch is the EXPECTED, HEALTHY state — it is what CI's no-database
  // job prints beside a green tick, and what every contributor without
  // Postgres sees. Opening with a negative made it read as a fault report:
  // on 2026-09-16 two reviewers each independently stopped to verify the
  // line was benign, and a third filed it as the one visible signal being
  // useless, because it looked alarming when fine and identical when broken.
  //
  // `main` writes to the console and returns a code, so these capture it.
  const captured = (
    argv: readonly string[],
    env: Record<string, string | undefined>,
    root: string,
  ) => {
    const lines: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    console.error = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      return { code: main(argv, env, root), text: lines.join("\n") };
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  const root = () => tree({ "tests/a.test.ts": GATED, "tests/b.test.ts": PLAIN });

  it("opens the healthy-but-skipping report with a verdict, not with a negative", () => {
    // Mutation: revert the first line to `${summary} ${DB_URL_ENV} is NOT set`.
    // Every other assertion in this file still passes; only this one catches it.
    const { code, text } = captured([], {}, root());
    expect(code).toBe(0);
    expect(text.split("\n")[0]).toMatch(/^OK/);
  });

  it("still says plainly that the suites will be skipped", () => {
    // The framing changed; the information must not have been softened away.
    // Reading as calm is worthless if it also reads as "everything ran".
    // Mutation: drop the "will be skipped" sentence while keeping the OK.
    const { text } = captured([], {}, root());
    expect(text).toMatch(/SKIP/);
    expect(text).toContain("tests/a.test.ts");
  });

  it("makes the report and the failure visibly different at a glance", () => {
    // The property that makes a log scannable: a reader must be able to tell
    // the expected state from the broken one by the first token alone, without
    // reading far enough to reach the variable name they have in common.
    // Mutation: give both branches the same opening word.
    const skipping = captured([], {}, root());
    const failing = captured(["--require-db"], {}, root());
    expect(skipping.code).toBe(0);
    expect(failing.code).toBe(1);
    expect(skipping.text.split("\n")[0]).not.toBe(failing.text.split("\n")[0]);
    expect(failing.text.split("\n")[0]).toMatch(/^FAIL/);
  });

  it("confirms out loud when the suites WILL run", () => {
    // The healthy-and-enabled case needs its own unambiguous sentence, or a
    // reader is left inferring success from the absence of a warning.
    // Mutation: return 0 silently when the variable is set.
    const { code, text } = captured([], { [DB_URL_ENV]: "postgres://x/y" }, root());
    expect(code).toBe(0);
    expect(text).toMatch(/^OK: the database suites will run/);
  });

  it("names DATABASE_URL when that was set instead, in both modes", () => {
    // The reasonable guess, answered. In the reporting mode it saves a
    // contributor a silently vacuous run; in `--require-db` it distinguishes
    // "the CI service container died" from "somebody wired the wrong variable
    // name", which are very different repairs.
    // Mutation: delete either `status.state === "near-miss"` branch.
    const env = { DATABASE_URL: "postgresql://me:pw@localhost:5432/my_real_db" };
    expect(captured([], env, root()).text).toContain("DATABASE_URL is set, but");
    expect(captured(["--require-db"], env, root()).text).toMatch(/DATABASE_URL IS set here/);
  });

  it("does not mention DATABASE_URL when it was not set", () => {
    // Advice shown unconditionally is advice a reader learns to ignore, and a
    // signal nobody reads has the same value as no signal at all.
    // Mutation: append the near-miss note regardless of state.
    expect(captured([], {}, root()).text).not.toMatch(/DATABASE_URL is set, but/);
  });
});
