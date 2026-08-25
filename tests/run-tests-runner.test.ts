// The runner that makes a failing test run impossible to read as a passing one.
//
// Context, because the fix is not where the bug was reported to be: three
// crews reported `npx vitest run` exiting 0 with failures. Vitest's exit code
// is correct — measured directly, it exits 1 on a failing test, on the full
// suite with 5 failed files, and on the `--reporter=basic` startup error. What
// loses the status is the shell: `... | tail` reports tail's 0. See
// `scripts/run-tests.mjs`'s header for the full measurement.
//
// So the guarantee under test here is the half that survives a pipe: the
// printed summary is parsed, and a run whose summary shows failures — or shows
// nothing at all — fails regardless of the status the child returned.
import { describe, expect, it } from "vitest";

import { assertReporterIsLoadable, summaryOf, verdictFor } from "../scripts/run-tests.mjs";

/** A summary block in vitest 4's real format, as printed to the console. */
function summaryText(counts: {
  filesFailed?: number;
  filesPassed?: number;
  filesSkipped?: number;
  filesTotal?: number;
  testsFailed?: number;
  testsPassed?: number;
  testsSkipped?: number;
  testsTotal?: number;
}) {
  const {
    filesFailed = 0,
    filesPassed = 0,
    filesSkipped = 0,
    filesTotal = filesFailed + filesPassed + filesSkipped,
    testsFailed = 0,
    testsPassed = 0,
    testsSkipped = 0,
    testsTotal = testsFailed + testsPassed + testsSkipped,
  } = counts;
  const part = (n: number, word: string) => (n > 0 ? `${n} ${word}` : null);
  const line = (f: number, p: number, s: number, total: number) =>
    [part(f, "failed"), part(p, "passed"), part(s, "skipped")].filter(Boolean).join(" | ") +
    ` (${total})`;
  return [
    ` Test Files  ${line(filesFailed, filesPassed, filesSkipped, filesTotal)}`,
    `      Tests  ${line(testsFailed, testsPassed, testsSkipped, testsTotal)}`,
    "   Start at  00:27:26",
    "   Duration  320ms",
  ].join("\n");
}

describe("summaryOf reads vitest's printed counts", () => {
  it("parses the real summary of a run with failures", () => {
    // Copied from an actual failing run of this repo's suite.
    const output = summaryText({
      filesFailed: 5,
      filesPassed: 281,
      filesSkipped: 78,
      filesTotal: 364,
      testsFailed: 5,
      testsPassed: 5481,
      testsSkipped: 1806,
      testsTotal: 7292,
    });
    expect(summaryOf(output).files).toEqual({
      failed: 5,
      passed: 281,
      skipped: 78,
      total: 364,
    });
    expect(summaryOf(output).tests).toMatchObject({ failed: 5, passed: 5481 });
  });

  it("parses counts through ANSI colour codes", () => {
    // Vitest colours its summary whenever stdout is a TTY, and the escape
    // sequences sit between the number and the word — so a parser that did not
    // strip them would read every count as zero and pass a failing run.
    const esc = String.fromCharCode(27);
    const coloured = ` Test Files  ${esc}[1m${esc}[31m3 failed${esc}[39m${esc}[22m | 10 passed (13)\n      Tests  3 failed | 40 passed (43)`;
    expect(summaryOf(coloured).files).toMatchObject({ failed: 3, passed: 10, total: 13 });
  });

  it("returns nulls when there is no summary to read", () => {
    expect(summaryOf("Startup Error: Failed to load custom Reporter from basic")).toEqual({
      files: null,
      tests: null,
    });
  });
});

describe("verdictFor never lets a failing run report success", () => {
  it("fails when the summary shows failures even though the child exited 0", () => {
    // The reported bug, reduced to its essence: this is what a piped run hands
    // us — a zero status attached to output that says five files failed.
    const verdict = verdictFor(
      0,
      summaryText({ filesFailed: 5, filesPassed: 281, testsFailed: 5 }),
    );
    expect(verdict.code).not.toBe(0);
    expect(verdict.reason).toMatch(/summary reports 5 failed file/);
  });

  it("fails an empty run that exited 0 having executed nothing", () => {
    // `--reporter=basic` produced exactly this, and so does any file filter
    // that matches nothing — a fast, clean, meaningless green.
    expect(verdictFor(0, summaryText({ filesTotal: 0, testsTotal: 0 })).code).not.toBe(0);
  });

  it("fails a zero-status run that printed no readable summary", () => {
    // Fails closed. A run that exits 0 without evidence that anything ran is
    // the exact shape of the empty green run this exists to catch.
    const verdict = verdictFor(0, "some output, but no summary block");
    expect(verdict.code).not.toBe(0);
    expect(verdict.reason).toMatch(/no summary/);
  });

  it("preserves a non-zero status rather than inventing its own", () => {
    // The task that commissioned this forbade a wrapper that masks real exit
    // codes, so a child's failure must pass through with its own number.
    expect(verdictFor(2, summaryText({ filesPassed: 10, testsPassed: 40 })).code).toBe(2);
  });

  it("fails when the child was killed by a signal (status null)", () => {
    // spawnSync reports a signalled child as status null, which is not 0 but
    // also cannot be used as an exit code.
    expect(verdictFor(null, "").code).toBe(1);
  });

  it("passes a genuinely clean run", () => {
    // The check must be able to say yes, or it is just a broken build.
    const verdict = verdictFor(
      0,
      summaryText({ filesPassed: 281, filesSkipped: 78, testsPassed: 5481 }),
    );
    expect(verdict.code).toBe(0);
  });

  it("passes a run whose files all skipped, since a skip is not a failure", () => {
    // Deliberate: the database-gated majority of this suite skips without
    // TEST_DATABASE_URL, and failing that here would make a no-database run
    // impossible. Which suites were skipped is `check:db-gated`'s question,
    // not this one's — see CLAUDE.md.
    expect(verdictFor(0, summaryText({ filesSkipped: 40, testsSkipped: 400 })).code).toBe(0);
  });

  it("has no path that turns a non-zero status into a zero", () => {
    // The anti-masking property stated as an exhaustive check rather than a
    // promise: across every summary shape above, a failing child stays failing.
    const summaries = [
      summaryText({ filesPassed: 281, testsPassed: 5481 }),
      summaryText({ filesTotal: 0, testsTotal: 0 }),
      "no summary at all",
      "",
    ];
    for (const status of [1, 2, 130, null]) {
      for (const output of summaries) {
        expect(verdictFor(status, output).code).not.toBe(0);
      }
    }
  });
});

describe("assertReporterIsLoadable refuses a reporter that would run nothing", () => {
  it("rejects --reporter=basic, which was removed in vitest 3", () => {
    const result = assertReporterIsLoadable(["--reporter=basic"]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/NO tests/);
  });

  it("rejects the space-separated spelling too", () => {
    expect(assertReporterIsLoadable(["--reporter", "basic"]).ok).toBe(false);
  });

  it("names a replacement, so the message is actionable", () => {
    // Vitest's own error says only that it could not resolve `basic`, with no
    // way to point at a working reporter. Naming one is the sole thing this
    // adds over letting the startup error speak.
    expect(assertReporterIsLoadable(["--reporter=basic"]).message).toMatch(/dot|default/);
  });

  it("allows reporters that do exist", () => {
    expect(assertReporterIsLoadable(["--reporter=dot"]).ok).toBe(true);
    expect(assertReporterIsLoadable(["--reporter", "verbose"]).ok).toBe(true);
    expect(assertReporterIsLoadable([]).ok).toBe(true);
  });

  it("does not mistake a test file named after the reporter for the flag", () => {
    expect(assertReporterIsLoadable(["tests/basic.test.ts"]).ok).toBe(true);
  });
});
