// Pure report-parsing logic for the mutation-testing wrapper
// (`scripts/run-mutation-tests.mjs`), split out so it can be unit tested
// directly against synthetic `mutation.json`-shaped fixtures without
// spawning Stryker. See that script's module doc comment for the full
// rationale: everything here reads report CONTENT, never a process exit
// code.
import { existsSync, readFileSync, rmSync } from "node:fs";

/**
 * Guard (a) + (c): walks every mutant in a Stryker `mutation.json` report
 * and verifies that any mutant marked "Killed" is backed by a non-empty,
 * resolvable `killedBy` list of NAMED tests. Throws if any Killed mutant
 * has no attributed test — that shape (kill reported, no named test
 * responsible) is exactly what a whole-suite collection failure produces
 * when something upstream is deciding "killed" from a nonzero exit code
 * instead of the report, so it is a hard error here, never a warning.
 *
 * Returns the list of attributed kills (file, mutant id, mutator, and the
 * resolved test names that killed it) on success.
 */
export function verifyNamedKills(report) {
  const testFiles = report.testFiles ?? {};
  const testsById = new Map();
  for (const file of Object.values(testFiles)) {
    for (const test of file.tests ?? []) {
      testsById.set(test.id, test.name);
    }
  }

  const unattributedKills = [];
  const attributedKills = [];

  for (const [filePath, fileResult] of Object.entries(report.files ?? {})) {
    for (const mutant of fileResult.mutants ?? []) {
      if (mutant.status !== "Killed") continue;

      const killedBy = mutant.killedBy ?? [];
      if (killedBy.length === 0) {
        unattributedKills.push({ filePath, mutant });
        continue;
      }

      const names = killedBy.map((id) => testsById.get(id) ?? `<unresolvable test id ${id}>`);
      attributedKills.push({
        filePath,
        mutantId: mutant.id,
        mutatorName: mutant.mutatorName,
        names,
      });
    }
  }

  if (unattributedKills.length > 0) {
    const detail = unattributedKills
      .slice(0, 5)
      .map((u) => `  - ${u.filePath} mutant #${u.mutant.id} (${u.mutant.mutatorName})`)
      .join("\n");
    throw new Error(
      `${unattributedKills.length} mutant(s) were reported Killed with no named test in ` +
        `\`killedBy\`. That is the exact false-positive shape this harness exists to catch — ` +
        `never trust a kill without a named test attached:\n${detail}`,
    );
  }

  return attributedKills;
}

/**
 * Killed / (Killed + Survived + Timeout), mirroring Stryker's own
 * definition of mutation score, computed from report content rather than
 * trusting a pre-computed summary field. Returns null when there is
 * nothing to score (e.g. every mutant was NoCoverage).
 */
export function computeMutationScore(report) {
  const mutants = Object.values(report.files ?? {}).flatMap((f) => f.mutants ?? []);
  const relevant = mutants.filter((m) => ["Killed", "Survived", "Timeout"].includes(m.status));
  if (relevant.length === 0) return null;
  const killed = relevant.filter((m) => m.status === "Killed" || m.status === "Timeout");
  return (killed.length / relevant.length) * 100;
}

/**
 * Guard (b): given a report and the file/line of the dedicated control
 * fixture's provably-unreachable statement, throws if any mutant at that
 * line was reported "Killed". Returns the matched mutants' statuses on
 * success (for logging).
 */
export function assertDeadLineNeverKilled(report, filePath, deadLine) {
  const fileResult = report.files?.[filePath];
  if (!fileResult || (fileResult.mutants ?? []).length === 0) {
    throw new Error(
      `no mutants were generated for ${filePath} at all — the harness produced nothing to check.`,
    );
  }

  const deadLineMutants = fileResult.mutants.filter((m) => m.location.start.line === deadLine);
  if (deadLineMutants.length === 0) {
    throw new Error(
      `expected at least one mutant at ${filePath}:${deadLine} (the fixture's unreachable ` +
        `return statement) but the report has none there.`,
    );
  }

  const falselyKilled = deadLineMutants.filter((m) => m.status === "Killed");
  if (falselyKilled.length > 0) {
    const detail = falselyKilled
      .map(
        (m) =>
          `${m.mutatorName} (${m.replacement ?? "?"}) killed by ${JSON.stringify(m.killedBy ?? [])}`,
      )
      .join("; ");
    throw new Error(
      `a mutation to code that can never execute was reported KILLED: ${detail}. No test can ` +
        `genuinely observe an unreachable branch, so this can only mean the harness itself is ` +
        `misattributing failures.`,
    );
  }

  return deadLineMutants.map((m) => m.status);
}

/**
 * Deletes any file at `reportPath` if one exists, otherwise does nothing.
 *
 * Called immediately before every Stryker invocation in
 * `scripts/run-mutation-tests.mjs`. Stryker writes its JSON report to a
 * fixed path on every invocation, and this wrapper makes two invocations
 * per run (the control-fixture run, then the real run). Without this,
 * a real run that crashes before writing anything — e.g. Stryker's dry
 * run fails during test collection — leaves the file on disk exactly as
 * the control run left it: complete, well-formed, and structurally
 * indistinguishable from a genuine result. `readReportOrThrow` below would
 * then happily parse that stale file and hand back a report that has
 * nothing to do with the invocation that just failed. Deleting the file
 * before every invocation closes that gap: by the time an invocation's
 * Stryker process exits, whatever is at `reportPath` is either what THAT
 * invocation wrote, or nothing — never a previous invocation's leftover.
 */
export function clearReportFile(reportPath) {
  rmSync(reportPath, { force: true });
}

/**
 * Reads and parses the JSON report at `reportPath`, or throws a hard,
 * explicit error naming which run (`label`) was expected to have written
 * it.
 *
 * A missing report is not a pass — it means the run being checked never
 * proved anything, and treating "no evidence" as "the gate passed" is the
 * exact false-confidence shape this whole harness exists to prevent
 * (see the wrapper's module doc comment). This function is the only
 * place that decides whether a report file exists and is readable; every
 * caller either gets a parsed report object back or an Error, never a
 * silent `undefined`/`null` that a caller could accidentally treat as
 * "nothing to check, must be fine."
 */
export function readReportOrThrow(reportPath, label) {
  if (!existsSync(reportPath)) {
    throw new Error(
      `the ${label} produced no report at ${reportPath}. Stryker likely failed before writing ` +
        "output (e.g. it crashed during its initial dry run) — check the console output above " +
        "for the actual error, then fix it. A run that wrote no report has proven nothing and " +
        "must never be treated as a pass.",
    );
  }
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

/**
 * Guards the incremental result cache — a second piece of persisted state
 * beyond `mutation.json`, introduced by `--incremental` (see
 * `stryker.config.json`). Stryker reuses a prior mutant's verdict from this
 * file instead of re-testing it, so unlike `mutation.json` (read once, right
 * after the run that wrote it, then deleted) this file is deliberately kept
 * across invocations — which is exactly the shape that produced the
 * false-PASS bug `clearReportFile`/`readReportOrThrow` above exist to close:
 * a persisted file that could be read as current when it isn't.
 *
 * This function does NOT try to re-verify what Stryker's own incremental
 * differ decides is reusable — that decision is keyed on a diff of the
 * exact source text at each mutant's location (and, for a killed mutant,
 * the killing test's own source text too), which is Stryker's job, tested
 * empirically for this repository rather than re-implemented here. What
 * this function guards against is narrower and precedes that: a file that
 * isn't even a well-formed incremental report at all — the cache
 * equivalent of the stale/corrupt `mutation.json` this harness already
 * refuses to trust.
 *
 * Un-parseable JSON at `incrementalFile` is NOT a condition Stryker's own
 * project reader recovers from — `JSON.parse` throwing there is left to
 * propagate and crashes the dry run before any mutant runs, which
 * `readReportOrThrow` already turns into a hard failure (no `mutation.json`
 * gets written). That is a safe failure mode — loud, never a false PASS —
 * but it reports as an opaque Stryker crash rather than naming the actual
 * cause. Calling this FIRST, before invoking Stryker at all, turns that
 * same corruption into a clear, named error and self-heals by deleting the
 * bad file (a missing incremental file is an ordinary, supported Stryker
 * state — "no history yet, run everything" — never a failure), so a run
 * degrades to a full mutation run instead of dying opaquely.
 *
 * A well-formed-but-semantically-wrong file (valid JSON, wrong/missing
 * top-level keys) is treated the same way: deleted and logged, not
 * silently handed to Stryker to fail on in some less legible way.
 */
export function validateIncrementalCache(incrementalFilePath) {
  if (!existsSync(incrementalFilePath)) {
    return { hadCache: false, reason: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(incrementalFilePath, "utf8"));
  } catch (err) {
    rmSync(incrementalFilePath, { force: true });
    return {
      hadCache: false,
      reason: `the incremental cache at ${incrementalFilePath} was not valid JSON (${err.message}) — deleted it; this run will not reuse any prior mutant result.`,
    };
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof parsed.files !== "object" ||
    parsed.files === null
  ) {
    rmSync(incrementalFilePath, { force: true });
    return {
      hadCache: false,
      reason: `the incremental cache at ${incrementalFilePath} was valid JSON but not a recognisable mutation-testing report (missing/invalid "files") — deleted it; this run will not reuse any prior mutant result.`,
    };
  }

  return { hadCache: true, reason: null };
}
