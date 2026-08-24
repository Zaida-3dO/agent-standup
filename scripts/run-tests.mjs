#!/usr/bin/env node
/**
 * Runs the test suite so that a failing run cannot report success.
 *
 * ── The failure this exists to catch ────────────────────────────────────
 *
 * Three crews on 2026-08-25 reported a test run that "exited 0 with 106
 * failed test files", and a separate run under `--reporter=basic` that
 * "exited 0 having run nothing". Both were real observations. Neither
 * diagnosis was.
 *
 * **Vitest's own exit code is correct in both cases.** Measured directly on
 * vitest 4.1.10, with nothing between the runner and the shell:
 *
 *   - a failing test, run plainly            → exit 1
 *   - `--reporter=basic` (the reporter is
 *     not a real module in vitest 4, so it
 *     is a startup error)                    → exit 1
 *   - the full suite with 5 failed files     → exit 1
 *
 * What actually loses the status is the **pipe**. POSIX shells report a
 * pipeline's exit status as the status of its *last* command, so the
 * overwhelmingly common agent and CI idiom
 *
 *     npx vitest run 2>&1 | tail -40
 *
 * reports `tail`'s cheerful 0 and discards vitest's 1 entirely. The output
 * above it is truthful — it prints every failure — which is exactly why
 * this was mis-filed as "the exit code lies": a human reading the transcript
 * sees the failures, and a script checking `$?` sees success, so the two
 * disagree and the runner looks like the liar. `set -o pipefail` fixes it,
 * but it is off by default in `sh` and is not something a caller can be
 * relied upon to remember at the exact moment it matters.
 *
 * The `--reporter=basic` report is the same mistake one layer down: that
 * run also had its `$?` read through a pipe. The reporter genuinely is
 * broken (it was removed in vitest 4 — see `assertReporterIsLoadable`), and
 * it genuinely does run zero tests, but it does *not* exit 0.
 *
 * ── What this does about it ─────────────────────────────────────────────
 *
 * Two independent guarantees, deliberately not one:
 *
 *   1. **The child is spawned without a shell**, so there is no pipeline
 *      between vitest and this process and its status arrives intact. This
 *      process then exits with that status. A caller who pipes *us* can
 *      still lose our status the same way — that is unfixable from in here,
 *      which is why (2) exists.
 *
 *   2. **The printed summary is parsed and asserted on.** A run that
 *      executed no test files, or whose summary says a file or a test
 *      failed, fails here regardless of what status the child returned.
 *      This is the half that survives a pipe: it writes an explicit verdict
 *      line as the very last thing on stdout, so `| tail` still shows it.
 *
 * The second guarantee is the one that matters for the class of bug this
 * repo keeps finding — a check that passes without checking anything. An
 * empty run is the purest form of it: zero failures, zero assertions, and a
 * summary that reads as success.
 *
 * ── What this is NOT ────────────────────────────────────────────────────
 *
 * **It never converts a failure into a success.** It only ever turns a
 * would-be 0 into a non-zero. There is no path through this file that exits
 * 0 when the child exited non-zero — asserted by
 * `tests/run-tests-runner.test.ts`. That constraint is the point: the task
 * that commissioned this said, in terms, not to paper over the problem with
 * a wrapper that masks real exit codes.
 *
 * **A green run here means the summary reported no failures and a non-zero
 * number of test files ran.** It does not mean those tests assert anything
 * useful, and it explicitly does not mean the database-gated majority of
 * them executed — a skip is not a failure. That remains
 * `check:db-gated`'s claim to make, not this script's.
 *
 * Usage: `npm test [-- <vitest args>]`
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import process from "node:process";

const isWindows = process.platform === "win32";

/**
 * Reporters that cannot load, mapped to what to use instead.
 *
 * `basic` was removed in vitest 3 and is not a module in vitest 4, so
 * passing it produces "Failed to load custom Reporter from basic" and a run
 * that executes nothing. Vitest's own error names the string it could not
 * resolve, but has no way to suggest what to reach for instead; naming a
 * working replacement is the only thing added here.
 */
const REMOVED_REPORTERS = new Map([
  ["basic", "default (or `--reporter=dot` for the terse output `basic` used to give)"],
]);

/**
 * Refuses a reporter known to be unloadable, before spawning anything.
 *
 * Without this the run still fails — vitest exits 1 on the startup error —
 * but it fails having run zero tests, with a stack trace pointing into
 * vitest's bundled chunks and no indication that the fix is one word on the
 * command line.
 *
 * Exported for the test; the argument is the caller's raw argv tail.
 */
export function assertReporterIsLoadable(args) {
  for (const [index, arg] of args.entries()) {
    let value = null;
    if (arg.startsWith("--reporter=")) {
      value = arg.slice("--reporter=".length);
    } else if (arg === "--reporter") {
      value = args[index + 1] ?? null;
    }
    if (value === null) continue;

    const replacement = REMOVED_REPORTERS.get(value);
    if (replacement !== undefined) {
      return {
        ok: false,
        message:
          `--reporter=${value} is not a reporter in vitest 4 — it was removed, and passing it ` +
          `produces a startup error and a run that executes NO tests.\n` +
          `Use ${replacement} instead.`,
      };
    }
  }
  return { ok: true, message: null };
}

/**
 * Reads vitest's summary block out of its console output.
 *
 * Parsing the printed summary rather than a machine-readable report is a
 * deliberate trade. A JSON reporter would be sturdier against cosmetic
 * changes, but it costs the human-readable output that is the whole
 * reason a caller watches this run — and the counts are the thing being
 * cross-checked, so reading them from the same text the human reads is the
 * point. If vitest changes the format, `summaryOf` returns nulls and
 * `verdictFor` fails closed (see below) rather than passing silently.
 *
 * Lines look like:
 *   ` Test Files  5 failed | 281 passed | 78 skipped (364)`
 *   `      Tests  5 failed | 5481 passed | 1806 skipped (7292)`
 *
 * ANSI colour codes are stripped first: vitest emits them whenever its
 * stdout is a TTY, and they sit *between* the number and the word.
 */
export function summaryOf(output) {
  const plain = output.replace(/\[[0-9;]*m/g, "");

  const read = (label) => {
    const line = new RegExp(`^\\s*${label}\\s+(.+)$`, "m").exec(plain);
    if (line === null) return null;
    const counts = { failed: 0, passed: 0, skipped: 0, total: null };
    for (const [, n, word] of line[1].matchAll(/(\d+)\s+(failed|passed|skipped|todo)/g)) {
      if (word in counts) counts[word] += Number(n);
    }
    const total = /\((\d+)\)/.exec(line[1]);
    counts.total = total === null ? null : Number(total[1]);
    return counts;
  };

  return { files: read("Test Files"), tests: read("Tests") };
}

/**
 * Decides pass/fail from the child's status AND the summary it printed.
 *
 * The two are checked independently and the *stricter* wins, because each
 * covers a case the other misses: the status catches a crash that never
 * reaches the summary, and the summary catches a run that reported success
 * having executed nothing.
 *
 * Fails closed on an unreadable summary **only when the child exited 0** —
 * if the child already failed, its status is the honest answer and there is
 * no need to speculate about why the summary is missing. A run that exits 0
 * without printing a parseable summary is the exact shape of the empty
 * green run this exists to catch, so that case is a failure.
 *
 * Exported and pure so the test can drive every branch without spawning a
 * suite.
 */
export function verdictFor(status, output) {
  const { files, tests } = summaryOf(output);

  // Never rescue a failing child. Checked first and returned first so that
  // no later branch can turn a non-zero status into a 0.
  if (status !== 0) {
    return { code: status === null ? 1 : status, reason: `vitest exited ${status}` };
  }

  if (files === null || tests === null) {
    return {
      code: 1,
      reason:
        "vitest exited 0 but printed no summary this script could read, so there is no evidence " +
        "any test ran. Treating that as a failure rather than reporting an unverified success.",
    };
  }

  if (files.failed > 0 || tests.failed > 0) {
    return {
      code: 1,
      reason:
        `vitest exited 0 but its own summary reports ${files.failed} failed file(s) and ` +
        `${tests.failed} failed test(s). Failing on the summary.`,
    };
  }

  // An empty run. `--reporter=basic` produced exactly this shape, and so
  // does any filter that matches no file — `npm test -- tests/typo.test.ts`
  // is otherwise a fast, clean, entirely meaningless green.
  if (files.total === 0 || (files.passed === 0 && files.skipped === 0)) {
    return {
      code: 1,
      reason:
        "vitest exited 0 having run no test files at all. An empty run is not a passing run — " +
        "check the file filter, or the reporter, if one was passed.",
    };
  }

  return {
    code: 0,
    reason: `${files.passed} file(s) passed, ${tests.passed} test(s) passed`,
  };
}

function main() {
  const args = process.argv.slice(2);

  const reporter = assertReporterIsLoadable(args);
  if (!reporter.ok) {
    console.error(`\n[run-tests] ${reporter.message}\n`);
    process.exit(1);
  }

  // `shell: false` on POSIX is what makes the status trustworthy: there is
  // no pipeline for it to be reassigned by. Windows needs `npx.cmd` through
  // a shell because `.cmd` is not directly executable, matching the pattern
  // already used in scripts/run-mutation-tests.mjs; the status still comes
  // back from the one child, so nothing is masked there either.
  const result = spawnSync(isWindows ? "npx.cmd" : "npx", ["vitest", "run", ...args], {
    encoding: "utf8",
    shell: isWindows,
  });

  if (result.error) {
    console.error(`[run-tests] failed to launch vitest: ${result.error.message}`);
    process.exit(1);
  }

  // Printed before the verdict so the failures themselves are the bulk of
  // what a reader sees, and the verdict is the last word.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const verdict = verdictFor(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`);

  // The last line on stdout, deliberately: it is what survives `| tail`,
  // which is how this run is most often read.
  if (verdict.code === 0) {
    console.log(`\n[run-tests] PASS — ${verdict.reason}`);
  } else {
    console.error(`\n[run-tests] FAIL — ${verdict.reason}`);
  }
  process.exit(verdict.code);
}

// Only run when executed directly, so the test above can import the pure
// helpers without launching a suite.
//
// `pathToFileURL` rather than string-building the URL by hand: on Windows the
// naive `file://${path}` form yields `file://C:/…` where `import.meta.url` is
// `file:///C:/…`, so the comparison silently never matches and `main()` never
// runs — `npm test` then exits 0 having done absolutely nothing. That is the
// precise bug this file exists to prevent, and it was written into the file's
// own bootstrap on the first attempt; it was caught by running it, not by
// reading it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
