// Decides WHICH mutants a gate verdict is allowed to rest on: the ones that
// sit on lines this change actually added or modified, and no others.
//
// ── Why the verdict is per-hunk and not a score ─────────────────────────────
//
// The obvious gate is "mutation score >= N". This project already had one —
// `thresholds.break: 60` in `stryker.config.json`, compared against a single
// pooled ratio computed across every mutated file (`computeMutationScore` in
// `mutation-report-guards.mjs`). Switching that on as a required check was
// measured, on a real 5-file diff, to do the wrong thing:
//
//     overall           49.59 total / 60.54 covered   -> under break, FAIL
//     StatusPicker.tsx  91.30   <- newly written, deliberately well tested
//     status-picker.ts  90.91   <- newly written, deliberately well tested
//     ListView.tsx      59.66   <- pre-existing
//     ListViewContainer 34.36   <- pre-existing React wiring
//
// Both files the author actually wrote scored above 90. The run failed anyway,
// dragged under the threshold by a pre-existing container that a
// node-environment harness does not test by design. That is the gate failing
// honest work for code the author inherited, and its second-order effect is
// worse than the first: it teaches people not to touch weak files, and it
// creates standing pressure to lower the threshold — which
// `docs/plans/BEFORE-GA.md`'s "what must not happen" list forbids by name,
// because a threshold lowered to get green is a check that reports success
// without providing it.
//
// Every *absolute* score threshold keeps that defect in some measure, because
// the number it judges is a property of the whole file rather than of the
// change. Per-file thresholds narrow the blast radius but do not remove it: an
// author who adds three well-tested lines to a 34%-scoring container is still
// judged on the 34%.
//
// ── Why not a baseline / score delta either ────────────────────────────────
//
// The other candidate was recording a per-file baseline score and failing on a
// regression. Rejected for three reasons, in increasing order of seriousness:
//
//   1. A baseline is state that has to live somewhere and go stale. The first
//      PR after any drift argues with the file rather than the code.
//   2. It is gameable in the one direction that matters — a weak baseline,
//      once committed, licenses every future change to that file.
//   3. Mutation score is not stable run-to-run when the file's mutant
//      POPULATION changes shape, which is exactly what editing it does.
//      Adding a well-tested 10-line function to a weak file RAISES its score;
//      deleting dead code can LOWER it while improving the file. A delta gate
//      would fire on both. A noisy comparator on a required check manufactures
//      the flakes that teach people to re-run until green, and a gate people
//      re-run until green is decoration.
//
// ── What this does instead ─────────────────────────────────────────────────
//
// A survivor is judged only if it sits on a line the diff added or modified.
// That is attributable by construction: those lines exist because the author
// wrote them in this change, so a surviving mutant on one of them is a
// statement about THIS diff's tests and nothing else. Inherited weakness
// cannot reach the verdict, because inherited lines are not in the `+` side of
// any hunk — which means this gate can be switched on at full strength without
// any of the three things BEFORE-GA.md forbids: no threshold is lowered, no
// config is narrowed, no live mutant is annotated away.
//
// It also answers the open condition BEFORE-GA.md names for closing G1 —
// "agreement on what a survivor obliges" — in the only way that is fair on a
// mixed diff: a survivor on a line you wrote obliges you to kill it or to say
// why it cannot be killed; a survivor on a line you inherited obliges nothing
// and is reported as context.
//
// ── The known and deliberate gap ───────────────────────────────────────────
//
// A test whose HOLLOWNESS is only observable through unchanged code is not
// caught here. If you weaken an assertion in a test file while touching no
// source line, no source mutant moves into a hunk and this gate stays quiet.
// That is a real limit and it is accepted knowingly: this gate's promise is
// "no unkilled mutant on a line you wrote", not "your whole test suite is
// sound". A gate making the second promise is the whole-tree run whose cost
// is why the job was switched off in the first place. Narrow-and-honest beats
// broad-and-off.
import { spawnSync } from "node:child_process";

/**
 * Parses unified-diff text into a map of file path -> array of `[start, end]`
 * inclusive line ranges on the NEW side of the diff.
 *
 * Only the `+` side is collected, and that is the load-bearing detail: Stryker
 * reports every mutant's `location` against the file as it exists in the
 * working tree, which is the new side. Comparing a new-side mutant line
 * against an old-side range would be an off-by-however-much-the-diff-shifted
 * error that gets larger the further down the file you go, and would silently
 * judge the WRONG lines rather than failing loudly.
 *
 * Expects `git diff --unified=0` output. The zero-context flag is required,
 * not cosmetic: with default context (3 lines), every hunk header's range is
 * inflated by up to 3 unchanged lines on each side, so a surviving mutant on
 * an untouched line up to 3 lines away from an edit would be attributed to
 * this change. That is precisely the false-accusation this module exists to
 * prevent, so the caller pins `--unified=0` and this parser assumes it.
 *
 * A pure-deletion hunk (`+start,0`) contributes NO range. There is no new line
 * to attribute a mutant to, and a zero-length range would otherwise be stored
 * as the nonsensical `[start, start - 1]`.
 *
 * @param {string} diffText Unified diff, as produced by `git diff --unified=0`.
 * @returns {Map<string, Array<[number, number]>>}
 */
export function parseChangedLineRanges(diffText) {
  /** @type {Map<string, Array<[number, number]>>} */
  const ranges = new Map();
  let currentFile = null;

  for (const line of String(diffText ?? "").split("\n")) {
    // `+++ b/path/to/file.ts` names the new-side path for the hunks that
    // follow. `/dev/null` appears here for a deleted file — skipped, since a
    // file that no longer exists has no lines to attribute a mutant to (and
    // Stryker will not have mutated it either).
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      currentFile = raw === "/dev/null" ? null : raw.replace(/^b\//, "");
      continue;
    }

    if (!line.startsWith("@@") || currentFile === null) continue;

    // `@@ -oldStart,oldCount +newStart,newCount @@ optional trailing context`
    // The counts are OPTIONAL in unified-diff format and are omitted when they
    // equal 1 — `@@ -5 +5 @@` is legal and means one line each side. Defaulting
    // a missing count to 1 (rather than 0) is what makes a single-line change
    // register as a range instead of being silently dropped.
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!match) continue;

    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue;

    const list = ranges.get(currentFile) ?? [];
    list.push([start, start + count - 1]);
    ranges.set(currentFile, list);
  }

  return ranges;
}

/**
 * True when `line` falls inside any of `ranges` (inclusive on both ends).
 *
 * @param {number} line
 * @param {Array<[number, number]>} ranges
 */
export function lineIsInRanges(line, ranges) {
  return (ranges ?? []).some(([start, end]) => line >= start && line <= end);
}

/**
 * Collects the changed line ranges for the current branch relative to `base`.
 *
 * Uses the three-dot (`base...HEAD`) form deliberately, matching
 * `changedSourceFiles` in `mutation-scope.mjs`: three-dot diffs against the
 * MERGE BASE, so a change landing on `main` while this branch is open does not
 * show up as this branch's work. Two-dot would attribute other people's
 * commits to this author the moment `main` moved, which is the same
 * false-accusation failure in a different costume.
 *
 * Returns null when the diff cannot be computed. Null means "unknown", and the
 * caller must treat it as a hard failure rather than as an empty set — an
 * empty set would read as "no changed lines, therefore no survivor can be
 * attributed, therefore pass", turning a broken git invocation into a green
 * gate. That is the skip-green shape this whole change exists to remove.
 *
 * @param {string} base
 * @param {(cmd: string, args: string[]) => {status: number|null, stdout?: string, error?: Error}} [spawn]
 * @returns {Map<string, Array<[number, number]>> | null}
 */
export function changedLineRanges(base, spawn = defaultSpawn) {
  const diff = spawn("git", ["diff", "--unified=0", `${base}...HEAD`]);
  if (diff.error || diff.status !== 0) return null;
  return parseChangedLineRanges(diff.stdout ?? "");
}

function defaultSpawn(cmd, args) {
  return spawnSync(cmd, args, { encoding: "utf8" });
}

/**
 * Splits a Stryker report's mutants into the ones sitting on changed lines and
 * the ones inherited from code this diff did not touch.
 *
 * The split is computed over ALL mutant statuses, not just the failing ones,
 * so the caller can report an honest per-scope score alongside the verdict. A
 * `Timeout` counts as killed everywhere in this codebase (see
 * `computeMutationScore`), and `NoCoverage` is reported separately because a
 * mutant on a changed line that no test even executes is a stronger finding
 * than one that ran and survived, not a weaker one.
 *
 * `report.files` is keyed by whatever path form Stryker wrote — absolute on
 * some platforms, relative on others — so keys are normalised to
 * forward-slashed, repo-relative form before being matched against git's
 * always-relative, always-forward-slashed paths. Getting this wrong would
 * match nothing on Windows and report a clean gate for a filthy diff.
 *
 * @param {{files?: Record<string, {mutants?: Array<{status: string, location?: {start?: {line?: number}}, mutatorName?: string}>}>}} report
 * @param {Map<string, Array<[number, number]>>} rangesByFile
 */
export function splitMutantsByChangedLines(report, rangesByFile) {
  const changed = [];
  const inherited = [];

  for (const [rawPath, fileResult] of Object.entries(report?.files ?? {})) {
    const filePath = normaliseReportPath(rawPath);
    const ranges = lookupRanges(rangesByFile, filePath);

    for (const mutant of fileResult?.mutants ?? []) {
      const line = mutant?.location?.start?.line;
      const entry = {
        filePath,
        line: line ?? null,
        status: mutant?.status,
        mutatorName: mutant?.mutatorName,
      };
      // A mutant with no usable location cannot be proven to sit on a changed
      // line, so it is treated as inherited rather than as a finding. Failing
      // an author on a mutant nobody can point at would be unattributable, and
      // an unattributable failure is what makes people distrust a gate.
      if (typeof line === "number" && lineIsInRanges(line, ranges)) entry.changed = true;
      (entry.changed ? changed : inherited).push(entry);
    }
  }

  return { changed, inherited };
}

/**
 * Normalises a path from a Stryker report to the repo-relative, forward-slashed
 * form git emits. Handles both separators and strips any absolute prefix up to
 * and including the first `src/` segment, which is the only root this project
 * ever mutates (`mutate` patterns in `stryker.config.json` and
 * `filterChangedSourceFiles` both require a `src/` prefix).
 */
export function normaliseReportPath(rawPath) {
  const slashed = String(rawPath ?? "").replace(/\\/g, "/");
  const index = slashed.indexOf("src/");
  return index === -1 ? slashed : slashed.slice(index);
}

function lookupRanges(rangesByFile, filePath) {
  if (!rangesByFile) return [];
  const direct = rangesByFile.get(filePath);
  if (direct) return direct;
  // The report path has already been normalised to `src/...`; git paths are
  // repo-relative and should match directly. This second pass covers a diff
  // emitted with a path prefix the normaliser did not strip, matching on
  // suffix rather than giving up — a missed match here silently EXONERATES a
  // file, so it is worth one extra scan.
  for (const [key, value] of rangesByFile) {
    if (key.endsWith(filePath) || filePath.endsWith(key)) return value;
  }
  return [];
}

/**
 * The gate verdict: a survivor on a changed line fails, everything else is
 * context.
 *
 * `NoCoverage` on a changed line fails too, and deliberately. It means the
 * mutated line was never executed by any test at all — strictly stronger
 * evidence of an untested change than a mutant that ran and survived. Treating
 * it as acceptable would leave the single easiest way to pass this gate wide
 * open: add code no test calls.
 *
 * @param {{changed: Array<{status: string}>}} split
 */
export function findingsFromSplit(split) {
  return split.changed.filter((m) => m.status === "Survived" || m.status === "NoCoverage");
}

/**
 * Mutation score over a given mutant subset, matching `computeMutationScore`'s
 * definition (Killed + Timeout over Killed + Survived + Timeout) so a
 * per-scope number here is comparable with the pooled number reported
 * elsewhere. Returns null for an empty scope rather than 0 or 100 — "no
 * mutants" is not a score, and rendering it as either would be a claim the run
 * cannot support.
 */
export function scoreOf(mutants) {
  const relevant = (mutants ?? []).filter((m) =>
    ["Killed", "Survived", "Timeout"].includes(m.status),
  );
  if (relevant.length === 0) return null;
  const killed = relevant.filter((m) => m.status === "Killed" || m.status === "Timeout");
  return (killed.length / relevant.length) * 100;
}
