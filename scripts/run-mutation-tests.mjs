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
 * ── What decides pass/fail ───────────────────────────────────────────────
 *
 * Two different verdicts, because the two run modes answer two different
 * questions:
 *
 *   --changed-only  A survivor FAILS the run when it sits on a line the diff
 *                   added or modified; a survivor on an inherited line is
 *                   printed as context and never gates. The pooled
 *                   `thresholds.break` comparison is deliberately NOT applied
 *                   here — it judges a whole file's score, so it fails an
 *                   author for weakness they inherited, which is what kept
 *                   this gate switched off. Full reasoning, including why a
 *                   recorded baseline and a score delta were both rejected,
 *                   is in `scripts/lib/mutation-diff-scope.mjs`.
 *
 *   full scope      Keeps the pooled `thresholds.break` comparison. There is
 *                   no diff to attribute anything to, and a pooled threshold
 *                   is a reasonable thing for a whole-tree audit to use.
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
import path from "node:path";
import {
  verifyNamedKills,
  computeMutationScore,
  assertDeadLineNeverKilled,
  assertRequestedFilesMutated,
  clearReportFile,
  readReportOrThrow,
  validateIncrementalCache,
} from "./lib/mutation-report-guards.mjs";
import { changedSourceFiles, buildMutateArg } from "./lib/mutation-scope.mjs";
import {
  changedLineRanges,
  splitMutantsByChangedLines,
  findingsFromSplit,
  scoreOf,
} from "./lib/mutation-diff-scope.mjs";

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

  // Non-null only when this run is scoped to a specific changed-file list —
  // used below, after the run, to reconcile that every one of these files
  // was actually mutated (see `assertRequestedFilesMutated`). Left null for
  // a full/default-scope run, which has no fixed target list to reconcile
  // against.
  let requestedFiles = null;

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
      // `buildMutateArg` escapes every minimatch-magic character (most
      // importantly Next.js's own `[id]`-style dynamic route folders) in
      // each path before joining — see `scripts/lib/mutation-scope.mjs`'s
      // module doc comment for why a plain `files.join(",")` here silently
      // scopes a bracket route to zero files instead of itself.
      strykerArgs.push("--mutate", buildMutateArg(files));
      requestedFiles = files;
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

  // Captured rather than streamed live (`encoding: "utf8"` implies piped
  // stdio) specifically so its text can be parsed below for Stryker's own
  // file-resolution summary (`assertRequestedFilesMutated` needs to know
  // how many of the requested files Stryker's glob actually matched, and
  // that number is only ever printed to the console, never written to
  // `mutation.json` — see that guard's doc comment in
  // `mutation-report-guards.mjs`). Printed immediately after the process
  // exits so nothing is lost — spawnSync already blocks until Stryker
  // finishes either way, so visibility is delayed by at most the run's own
  // duration, never actually withheld.
  const result = spawnSync(isWindows ? "npx.cmd" : "npx", strykerArgs, {
    encoding: "utf8",
    shell: isWindows,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const strykerOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;

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
    // Reconciliation: every file this run was SCOPED to must actually have
    // been MATCHED by Stryker's own glob resolution (never inferred from
    // `report.files` presence alone — a legitimately mutant-free file, e.g.
    // a pure re-export barrel, is indistinguishable from a silently-dropped
    // one by presence alone; see `assertRequestedFilesMutated`'s doc
    // comment). This is what caught the original bracket-route bug and is
    // what will catch the next special character nobody has hit yet.
    if (requestedFiles) {
      assertRequestedFilesMutated(report, requestedFiles, strykerOutput);
    }
  } catch (err) {
    console.error(`[run-mutation-tests] ${err.message}`);
    process.exit(1);
  }
  printSummary(report, attributedKills);

  const score = computeMutationScore(report);
  const breakThreshold = report.thresholds?.break ?? null;

  // `score == null` means the run produced no Killed/Survived/Timeout
  // mutant at all — every mutant was NoCoverage, or (now that
  // `assertRequestedFilesMutated` above already threw for a --changed-only
  // run with a silently-empty scope) some other scope resolved to nothing.
  // This USED to print "PASS (nothing to prove)" and exit 0 — the exact
  // false-PASS shape that let the six bracket routes go untested while CI
  // stayed green. A run that proved nothing about any mutant must never be
  // treated as a pass.
  if (score == null) {
    console.error(
      "\n[run-mutation-tests] the run produced no scoreable mutants (no Killed, Survived, or " +
        "Timeout status among any mutant) for the requested scope. A run that proves nothing " +
        "must never be treated as a pass.",
    );
    process.exit(1);
  }

  // ── The verdict ────────────────────────────────────────────────────────
  //
  // For a --changed-only run the verdict is per-hunk, NOT the pooled score:
  // a survivor is a failure when it sits on a line this diff added or
  // modified, and is reported as context when it was inherited. The pooled
  // score is still printed (above, and again below) because it is useful to
  // know — it is just not what decides the outcome. See
  // `scripts/lib/mutation-diff-scope.mjs` for why an absolute threshold on a
  // pooled score fails honest work on inherited code, and why a recorded
  // baseline was rejected too.
  //
  // A full-scope run has no diff to judge against, so it keeps the original
  // `thresholds.break` behaviour. That is the whole-tree audit, not the PR
  // gate, and a pooled threshold is a reasonable thing for an audit to use.
  if (args.changedOnly) {
    const ranges = changedLineRanges(args.base);
    // null means the diff could not be computed. Treated as a hard failure,
    // never as "no changed lines" — an empty set would read as "no survivor
    // can be attributed, therefore pass", which turns a broken git
    // invocation into a green required check.
    if (ranges === null) {
      console.error(
        `\n[run-mutation-tests] could not compute the changed-line ranges against ${args.base}, so ` +
          `no survivor can be attributed to this change. Refusing to report a pass on a scope ` +
          `that could not be established.`,
      );
      process.exit(1);
    }

    const split = splitMutantsByChangedLines(report, ranges);
    const findings = findingsFromSplit(split);
    const changedScore = scoreOf(split.changed);
    const inheritedScore = scoreOf(split.inherited);

    console.log("\n=== Changed-line mutation verdict ===");
    console.log(
      `Mutants on lines this change touched: ${split.changed.length}` +
        (changedScore == null ? "" : ` (score ${changedScore.toFixed(2)}%)`),
    );
    console.log(
      `Mutants on inherited lines (reported, never gating): ${split.inherited.length}` +
        (inheritedScore == null ? "" : ` (score ${inheritedScore.toFixed(2)}%)`),
    );

    if (findings.length > 0) {
      console.error(
        `\n[run-mutation-tests] ${findings.length} mutant(s) on lines this change added or ` +
          `modified were not killed by any test:`,
      );
      for (const f of findings) {
        console.error(
          `  - ${f.filePath}:${f.line} [${f.mutatorName}] ${f.status}` +
            (f.status === "NoCoverage" ? " (no test executed this line at all)" : ""),
        );
      }
      console.error(
        `\nEach one is a line written by this change that every test still passes without. ` +
          `Kill it with a test that fails when the behaviour changes, or — if it is genuinely ` +
          `unkillable — say so at a scoped Stryker disable with the reason stated there.`,
      );
      process.exit(1);
    }

    console.log(
      `\n[run-mutation-tests] no surviving mutants on changed lines — all kills verified by ` +
        `name. Pooled score across the whole mutated scope: ${score.toFixed(2)}%. PASS.`,
    );
    return;
  }

  if (breakThreshold != null && score < breakThreshold) {
    console.error(
      `\n[run-mutation-tests] mutation score ${score.toFixed(2)}% is below the break threshold ` +
        `${breakThreshold}%.`,
    );
    process.exit(1);
  }

  console.log(
    `\n[run-mutation-tests] mutation score ${score.toFixed(2)}% — all kills verified by name. PASS.`,
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
