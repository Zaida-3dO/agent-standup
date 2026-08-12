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
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  verifyNamedKills,
  computeMutationScore,
  assertDeadLineNeverKilled,
} from "./lib/mutation-report-guards.mjs";

const REPORT_PATH = path.resolve("reports/mutation/mutation.json");
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
        `diffing against whatever ${base} currently resolves to locally.`,
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
 */
function assertControlSurvives() {
  spawnSync(
    isWindows ? "npx.cmd" : "npx",
    ["stryker", "run", "--mutate", CONTROL_FIXTURE_FILE, "--reporters", "json"],
    { stdio: "inherit", shell: isWindows },
  );
  // Deliberately not checking the exit code above — see the doc comment.
  // The verdict comes only from the report content read below.

  const report = readReport();
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

function readReport() {
  if (!existsSync(REPORT_PATH)) {
    throw new Error(
      `[run-mutation-tests] expected a report at ${REPORT_PATH} but none was written. ` +
        "Stryker likely failed before producing output — check the console output above.",
    );
  }
  return JSON.parse(readFileSync(REPORT_PATH, "utf8"));
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

  // Guard (b) first and always — if the harness can't prove a no-op
  // survives, nothing downstream is worth running.
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

  const report = readReport();
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

main();
