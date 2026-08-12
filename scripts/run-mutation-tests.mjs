#!/usr/bin/env node
/**
 * Runs Stryker mutation testing and verifies the result honestly, rather
 * than trusting Stryker's own process exit code.
 *
 * ── Why this wrapper exists, not just `stryker run` ─────────────────────
 *
 * A mutation-testing run reports a "kill" whenever a mutant makes some test
 * fail. If the *reason* a test suite exits non-zero is unrelated to the
 * specific mutant under test — a module failing to resolve, a fixture
 * erroring at collection — every mutant in that run can be misreported as
 * killed, because the process-level exit code went non-zero right on cue.
 * The mutation-testing report format Stryker emits (`mutation.json`)
 * already carries the structured truth: which named test(s), if any,
 * failed and killed each specific mutant. This wrapper reads *that*, never
 * a shell exit code, and treats a mutant with no attributed failing test
 * as unproven regardless of what anything else reported.
 *
 * Three properties this script enforces, and fails the run if any is
 * false. The report-parsing logic for all three lives in
 * `scripts/lib/mutation-report-guards.mjs` so it can be unit tested
 * directly against synthetic report fixtures — see
 * `tests/mutation-report-guards.test.ts` — without spawning Stryker:
 *
 *   (a) A mutant counts as killed ONLY when the report names at least one
 *       specific failing test that killed it (`killedBy`, non-empty).
 *       `verifyNamedKills`.
 *   (b) A no-op control mutant — one that changes nothing observable —
 *       MUST NOT be reported killed. If the harness reports a kill on a
 *       mutation to code no test can possibly observe, the harness itself
 *       is broken and every number it produces is worthless. This is
 *       checked, on every invocation, by running a dedicated fixture file
 *       (`src/lib/mutation-control.ts`) containing a provably unreachable
 *       statement and asserting that the report never marks the mutant at
 *       that exact line "Killed" — see `assertControlSurvives`, which
 *       calls `assertDeadLineNeverKilled`.
 *   (c) Every killed mutant attributes to a specific, named test — which
 *       is what proves a newly written test earns its place rather than
 *       duplicating an assertion something else already made. Also
 *       `verifyNamedKills` — the same non-empty `killedBy` check proves
 *       both (a) and (c) at once, since "killed by a named test" and
 *       "attributed to a specific test" are the same fact read two ways.
 *
 * ── Incremental result caching ───────────────────────────────────────────
 *
 * `stryker.config.json` sets `incremental: true`, so Stryker reuses a
 * mutant's prior verdict — keyed on the exact source text at its location,
 * and for a killed mutant, the killing test's own source text too — instead
 * of re-testing it when neither has changed. That reuse decision is
 * Stryker's own, not re-implemented here. What this wrapper adds on top:
 *
 *   - The control run (`assertControlSurvives`) always passes `--force`,
 *     so it NEVER reuses a prior verdict for its own fixture — a broken
 *     harness must be caught on every single invocation, not just the
 *     first one after it broke.
 *   - The cache file itself (`reports/stryker-incremental.json`) is
 *     validated before every real run — see `validateIncrementalCache` —
 *     and deleted rather than trusted if it is not well-formed. A cache
 *     persisted across runs is exactly the shape that produced this
 *     repository's earlier false-PASS bug in `mutation.json`; this closes
 *     the same gap for the second file that now persists state.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   node scripts/run-mutation-tests.mjs [--changed-only] [--base <ref>]
 *
 *   --changed-only   Scope `--mutate` to source files changed relative to
 *                     --base (default: origin/main) instead of the config
 *                     file's default `mutate` list. Used by CI so a run
 *                     stays proportional to the diff instead of the whole
 *                     tree.
 *   --base <ref>     Git ref to diff against when --changed-only is set.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  verifyNamedKills,
  computeMutationScore,
  assertDeadLineNeverKilled,
  clearReportFile,
  readReportOrThrow,
  validateIncrementalCache,
} from "./lib/mutation-report-guards.mjs";

const REPORT_PATH = path.resolve("reports/mutation/mutation.json");
// Must match `incrementalFile` in stryker.config.json — passed explicitly
// (rather than relying solely on the config file) so this script names the
// exact path it validates and clears, the same way REPORT_PATH does for
// `mutation.json`.
const INCREMENTAL_FILE_PATH = path.resolve("reports/stryker-incremental.json");
const isWindows = process.platform === "win32";

function parseArgs(argv) {
  const args = { changedOnly: false, base: "origin/main" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--changed-only") args.changedOnly = true;
    else if (argv[i] === "--base") args.base = argv[++i];
  }
  return args;
}

/**
 * Source files (under `src/`, TypeScript, excluding tests) changed relative
 * to `base`. Returns null (meaning "use the config default") when the diff
 * can't be computed — a --changed-only run on a branch with no source
 * changes returns an empty array (not null), which the caller treats as
 * "nothing to mutate" rather than falling back to the full default scope.
 */
function changedSourceFiles(base) {
  const fetchResult = spawnSync("git", ["fetch", "origin", "main", "--quiet"], {
    stdio: "inherit",
  });
  if (fetchResult.status !== 0) {
    console.warn(
      `[run-mutation-tests] \`git fetch origin main\` failed (exit ${fetchResult.status}); ` +
        `diffing against the local ref ${base} without refreshing it first.`,
    );
  }

  const diff = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    encoding: "utf8",
  });
  if (diff.status !== 0 || diff.error) {
    console.warn(
      `[run-mutation-tests] could not diff against ${base}; falling back to the config's default mutate scope.`,
    );
    return null;
  }

  const files = diff.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => f.startsWith("src/"))
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => existsSync(f));

  return files;
}

/**
 * The file/line inside `src/lib/mutation-control.ts` that a mutation can
 * never make observable — see that file's doc comment on `controlNoOp`
 * for why. Kept as a constant, not re-derived, so a future edit to that
 * file that moves the line is a loud "update this too" rather than a
 * silently wrong scan.
 */
const CONTROL_FIXTURE_FILE = "src/lib/mutation-control.ts";
const CONTROL_FIXTURE_DEAD_LINE = 37;

/**
 * Runs Stryker against the dedicated control fixture and asserts (via
 * `assertDeadLineNeverKilled`) that the report never calls the fixture's
 * provably-unreachable mutant "Killed". If it ever is, no test can
 * genuinely be causing that — the harness itself is broken, and every
 * kill count it has ever produced is suspect. Checked by reading
 * `mutation.json`'s own `status` field for that specific mutant, never
 * the process exit code (a single-file, low-mutant-count run trips the
 * configured break threshold on unrelated grounds and is expected to
 * exit non-zero even when this check passes).
 *
 * Mutates the whole fixture file rather than a precise column range,
 * deliberately: Stryker's location-based `--mutate` ranges proved
 * sensitive to shell-quoting differences across platforms during
 * development of this script, which is exactly the kind of
 * environment-dependent flakiness this guard exists to be immune to.
 * Scanning the resulting report for the fixed dead line by number is
 * robust to that; asking a shell to pass a byte-exact range is not.
 *
 * Always passes `--force`, unconditionally bypassing incremental reuse for
 * this invocation even though `stryker.config.json` sets `incremental:
 * true` project-wide. This check exists to catch the harness itself lying
 * about a kill — reusing a PRIOR run's verdict for this fixture would let a
 * broken harness's control check keep passing on an old, honest result
 * forever after the first correct run, which defeats the entire point of
 * running it on every invocation. `--force` still allows this run's own
 * result to be written back into the shared incremental cache afterward
 * (harmless — Stryker's own scope-tracking keeps it from displacing the
 * separately-scoped real run's cached entries, verified empirically before
 * this landed), it only skips READING any prior result for these mutants.
 */
function assertControlSurvives() {
  clearReportFile(REPORT_PATH);

  spawnSync(
    isWindows ? "npx.cmd" : "npx",
    [
      "stryker",
      "run",
      "--mutate",
      CONTROL_FIXTURE_FILE,
      "--reporters",
      "json",
      "--force",
      "--incrementalFile",
      INCREMENTAL_FILE_PATH,
    ],
    { stdio: "inherit", shell: isWindows },
  );
  // Deliberately not checking the exit code above — see the doc comment.
  // The verdict comes only from the report content read below.

  const report = readReportOrThrow(REPORT_PATH, "control run");
  let statuses;
  try {
    statuses = assertDeadLineNeverKilled(report, CONTROL_FIXTURE_FILE, CONTROL_FIXTURE_DEAD_LINE);
  } catch (err) {
    throw new Error(`[control mutant] ${err.message}`);
  }

  console.log(
    `[run-mutation-tests] control check passed: the unreachable-branch mutant at line ` +
      `${CONTROL_FIXTURE_DEAD_LINE} was never reported Killed (status: ${statuses.join(", ")}), as required.`,
  );
}

function printSummary(report, attributedKills) {
  const metrics = report.thresholds ? report.thresholds : {};
  console.log("\n=== Mutation testing summary (verified by report content, not exit code) ===");
  console.log(`Files mutated: ${Object.keys(report.files ?? {}).length}`);
  console.log(`Kills verified with a named attacking test: ${attributedKills.length}`);
  if (attributedKills.length > 0) {
    console.log("\nSample kill attributions:");
    for (const kill of attributedKills.slice(0, 10)) {
      console.log(`  - ${kill.filePath} [${kill.mutatorName}] killed by: ${kill.names.join(", ")}`);
    }
  }
  if (metrics.high != null || metrics.low != null || metrics.break != null) {
    console.log(
      `\nConfigured thresholds — high: ${metrics.high}, low: ${metrics.low}, break: ${metrics.break}`,
    );
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // Validate the incremental result cache before ANYTHING else — including
  // the control run below. `stryker.config.json` sets `incremental: true`
  // project-wide, so even the control run's own Stryker invocation reads
  // `reports/stryker-incremental.json` (it only opts out of REUSING what's
  // there via `--force`; the file still gets parsed on the way in). A
  // corrupt cache left unvalidated would crash the control run's dry run
  // before this script's own guards ever got a chance to explain why — see
  // `validateIncrementalCache`'s doc comment in `mutation-report-guards.mjs`.
  const cacheCheck = validateIncrementalCache(INCREMENTAL_FILE_PATH);
  if (cacheCheck.reason) {
    console.warn(`[run-mutation-tests] ${cacheCheck.reason}`);
  }

  // Guard (b) first and always — if the harness can't prove a no-op
  // survives, nothing downstream is worth running. Runs inside its own
  // try/catch (below, wrapping the whole function body) so a thrown
  // failure here exits loudly with a message instead of an uncaught
  // Node stack trace.
  assertControlSurvives();

  const strykerArgs = ["stryker", "run"];

  if (args.changedOnly) {
    const files = changedSourceFiles(args.base);
    if (files === null) {
      console.log("[run-mutation-tests] using the config file's default mutate scope.");
    } else if (files.length === 0) {
      console.log(
        `[run-mutation-tests] no mutable source files changed relative to ${args.base} — nothing to mutate.`,
      );
      process.exit(0);
    } else {
      console.log(`[run-mutation-tests] scoping mutation to ${files.length} changed file(s):`);
      for (const f of files) console.log(`  - ${f}`);
      strykerArgs.push("--mutate", files.join(","));
    }
  }

  // Clear the control run's report before this invocation — see
  // `clearReportFile()`. Without this, a real run that crashes before
  // writing its own report would leave the control run's stale report in
  // place, and `readReportOrThrow()` below would read THAT as if it were
  // the real run's result: exactly the false-PASS shape this wrapper
  // exists to prevent.
  clearReportFile(REPORT_PATH);

  // The cache was already validated (and, if unusable, deleted) at the top
  // of main() — before the control run, which reads the same shared file.
  // Pin the path explicitly here too so this invocation and the control
  // run are provably reading/writing the exact same file, not relying on
  // both agreeing with stryker.config.json by coincidence.
  strykerArgs.push("--incrementalFile", INCREMENTAL_FILE_PATH);

  const result = spawnSync(isWindows ? "npx.cmd" : "npx", strykerArgs, {
    stdio: "inherit",
    shell: isWindows,
  });

  // Deliberately NOT checking result.status here to decide pass/fail — see
  // the module doc comment. Stryker's own exit code is used only to decide
  // whether to even attempt reading a report; the verdict comes from the
  // report's content.
  if (result.error) {
    console.error(`[run-mutation-tests] failed to launch Stryker: ${result.error.message}`);
    process.exit(1);
  }

  const report = readReportOrThrow(REPORT_PATH, args.changedOnly ? "--changed-only run" : "run");
  let attributedKills;
  try {
    attributedKills = verifyNamedKills(report);
  } catch (err) {
    console.error(`[run-mutation-tests] ${err.message}`);
    process.exit(1);
  }
  printSummary(report, attributedKills);

  const score = computeMutationScore(report);
  const breakThreshold = report.thresholds?.break ?? null;

  if (score != null && breakThreshold != null && score < breakThreshold) {
    console.error(
      `\n[run-mutation-tests] mutation score ${score.toFixed(2)}% is below the break threshold ` +
        `${breakThreshold}%.`,
    );
    process.exit(1);
  }

  console.log(
    score != null
      ? `\n[run-mutation-tests] mutation score ${score.toFixed(2)}% — all kills verified by name. PASS.`
      : "\n[run-mutation-tests] no mutants were generated for the requested scope. PASS (nothing to prove).",
  );
}

try {
  main();
} catch (err) {
  // Anything thrown above (assertControlSurvives's control-mutant check,
  // or readReport's "no report was written" guard) is a hard failure of
  // this wrapper's own load-bearing checks — never allowed to surface as
  // an uncaught-exception stack trace that a CI log reader could mistake
  // for an unrelated crash. Print the message plainly and exit non-zero.
  console.error(`\n[run-mutation-tests] FAILED: ${err.message}`);
  process.exit(1);
}
