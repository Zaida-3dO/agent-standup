// Proves the mutation-testing wrapper's own load-bearing guards against
// synthetic Stryker report fixtures, without spawning Stryker itself.
//
// This is the self-check acceptance criterion #3 (in the task this PR
// closes) calls for: proof that kill-detection reads the report's named
// `killedBy` test attribution, never a process exit code. A whole-suite
// collection failure exits non-zero with every mutant's *test run* also
// failing — that shape is reproduced here as `killedWithoutAttribution`,
// and `verifyNamedKills` must reject it exactly as it would reject a real
// Stryker report produced by that failure mode.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  verifyNamedKills,
  computeMutationScore,
  assertDeadLineNeverKilled,
  assertRequestedFilesMutated,
  parseMatchedFileSummary,
  clearReportFile,
  readReportOrThrow,
  validateIncrementalCache,
} from "../scripts/lib/mutation-report-guards.mjs";

function reportWith(
  mutants: Array<Record<string, unknown>>,
  testFiles: Record<string, unknown> = {},
) {
  return {
    schemaVersion: "1",
    thresholds: { high: 90, low: 70, break: 60 },
    testFiles,
    files: {
      "src/lib/example.ts": {
        language: "typescript",
        source: "",
        mutants,
      },
    },
  };
}

const namedTestFiles = {
  "tests/example.test.ts": {
    tests: [{ id: "0", name: "example does the thing" }],
  },
};

describe("verifyNamedKills", () => {
  it("accepts a Killed mutant whose killedBy names a real test, and resolves that test's name", () => {
    const report = reportWith(
      [
        {
          id: "1",
          mutatorName: "EqualityOperator",
          status: "Killed",
          killedBy: ["0"],
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        },
      ],
      namedTestFiles,
    );

    const kills = verifyNamedKills(report);

    expect(kills).toHaveLength(1);
    const [onlyKill] = kills;
    expect(onlyKill?.names).toEqual(["example does the thing"]);
  });

  // This is the exact false-positive shape a whole-suite collection
  // failure produces: Stryker sees every test "fail" (because none of
  // them could even run) and, if a caller trusted the process exit code
  // instead of this attribution, would count it as a kill. A report that
  // marks a mutant Killed with an EMPTY killedBy is what that failure
  // mode looks like on disk — this must be rejected, not counted.
  it("rejects a Killed mutant with an empty killedBy — the exit-code-collection-failure shape", () => {
    const killedWithoutAttribution = reportWith([
      {
        id: "1",
        mutatorName: "EqualityOperator",
        status: "Killed",
        killedBy: [],
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      },
    ]);

    expect(() => verifyNamedKills(killedWithoutAttribution)).toThrow(/no named test/i);
  });

  it("rejects a Killed mutant with killedBy entirely absent (not just empty)", () => {
    const report = reportWith([
      {
        id: "1",
        mutatorName: "EqualityOperator",
        status: "Killed",
        // killedBy omitted entirely — schema marks it optional.
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      },
    ]);

    expect(() => verifyNamedKills(report)).toThrow(/no named test/i);
  });

  it("ignores Survived and NoCoverage mutants — they are not kills and need no attribution", () => {
    const report = reportWith([
      {
        id: "1",
        mutatorName: "StringLiteral",
        status: "Survived",
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      },
      {
        id: "2",
        mutatorName: "BlockStatement",
        status: "NoCoverage",
        location: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } },
      },
    ]);

    expect(() => verifyNamedKills(report)).not.toThrow();
    expect(verifyNamedKills(report)).toEqual([]);
  });

  it("resolves an unresolvable test id to a labelled placeholder rather than silently dropping it", () => {
    const report = reportWith(
      [
        {
          id: "1",
          mutatorName: "EqualityOperator",
          status: "Killed",
          killedBy: ["does-not-exist"],
          location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        },
      ],
      namedTestFiles,
    );

    const kills = verifyNamedKills(report);
    const [onlyKill] = kills;
    const [onlyName] = onlyKill?.names ?? [];
    expect(onlyName).toMatch(/unresolvable test id/);
  });
});

describe("computeMutationScore", () => {
  it("computes Killed / (Killed + Survived + Timeout), excluding NoCoverage", () => {
    const report = reportWith([
      {
        id: "1",
        status: "Killed",
        killedBy: ["0"],
        mutatorName: "X",
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      },
      {
        id: "2",
        status: "Killed",
        killedBy: ["0"],
        mutatorName: "X",
        location: { start: { line: 2, column: 1 }, end: { line: 2, column: 2 } },
      },
      {
        id: "3",
        status: "Survived",
        mutatorName: "X",
        location: { start: { line: 3, column: 1 }, end: { line: 3, column: 2 } },
      },
      {
        id: "4",
        status: "NoCoverage",
        mutatorName: "X",
        location: { start: { line: 4, column: 1 }, end: { line: 4, column: 2 } },
      },
    ]);

    // 2 killed out of 3 scoreable (2 Killed + 1 Survived); NoCoverage
    // excluded entirely, matching Stryker's own definition.
    expect(computeMutationScore(report)).toBeCloseTo((2 / 3) * 100, 5);
  });

  it("returns null when there is nothing scoreable", () => {
    const report = reportWith([
      {
        id: "1",
        status: "NoCoverage",
        mutatorName: "X",
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
      },
    ]);
    expect(computeMutationScore(report)).toBeNull();
  });
});

describe("assertDeadLineNeverKilled", () => {
  const filePath = "src/lib/mutation-control.ts";

  it("passes and returns statuses when the target line's mutants are Survived or NoCoverage", () => {
    const report = {
      files: {
        [filePath]: {
          mutants: [
            {
              id: "1",
              status: "NoCoverage",
              mutatorName: "StringLiteral",
              location: { start: { line: 37, column: 1 }, end: { line: 37, column: 2 } },
            },
          ],
        },
      },
    };

    expect(assertDeadLineNeverKilled(report, filePath, 37)).toEqual(["NoCoverage"]);
  });

  it("throws when a mutant at the dead line is reported Killed — the harness would be lying", () => {
    const report = {
      files: {
        [filePath]: {
          mutants: [
            {
              id: "1",
              status: "Killed",
              killedBy: ["0"],
              mutatorName: "StringLiteral",
              location: { start: { line: 37, column: 1 }, end: { line: 37, column: 2 } },
            },
          ],
        },
      },
    };

    expect(() => assertDeadLineNeverKilled(report, filePath, 37)).toThrow(/reported KILLED/);
  });

  it("throws when the file has no mutants at all", () => {
    const report = { files: { [filePath]: { mutants: [] } } };
    expect(() => assertDeadLineNeverKilled(report, filePath, 37)).toThrow(
      /no mutants were generated/,
    );
  });

  it("throws when the dead line itself has no mutant (fixture drifted from the constant)", () => {
    const report = {
      files: {
        [filePath]: {
          mutants: [
            {
              id: "1",
              status: "Survived",
              mutatorName: "X",
              location: { start: { line: 12, column: 1 }, end: { line: 12, column: 2 } },
            },
          ],
        },
      },
    };

    expect(() => assertDeadLineNeverKilled(report, filePath, 37)).toThrow(
      /expected at least one mutant at/i,
    );
  });
});

// Stryker's own `Project.logFiles` (@stryker-mutator/core's `fs/project.js`)
// logs exactly this shape after resolving `--mutate` patterns against the
// project's file list — straight from the SAME glob resolution that decides
// what gets instrumented, not a guess. `parseMatchedFileSummary` is the only
// thing standing between a genuine drop and a legitimately mutant-free file
// (see the `assertRequestedFilesMutated` suite below for why `report.files`
// presence alone cannot make that distinction).
describe("parseMatchedFileSummary", () => {
  it("parses a real 'Found N of M' line (captured verbatim from a live stryker run)", () => {
    const realOutput =
      "[32m23:08:48 (61232) INFO ProjectReader[39m Found 2 of 242 file(s) to be mutated.\n";
    expect(parseMatchedFileSummary(realOutput)).toEqual({ matched: 2, scanned: 242 });
  });

  it("parses the incremental-report suffix variant of the same line", () => {
    const realOutput =
      "Found 1 of 243 file(s) to be mutated using incremental report with 7 mutant(s), and 1 test(s).\n";
    expect(parseMatchedFileSummary(realOutput)).toEqual({ matched: 1, scanned: 243 });
  });

  it("treats the 'No files found for mutation' warning as matched: 0", () => {
    const realOutput =
      "Warning: No files found for mutation with the given glob expressions. As a result, a dry-run will be performed without actually modifying anything.";
    expect(parseMatchedFileSummary(realOutput)).toEqual({ matched: 0, scanned: null });
  });

  it("returns null when neither line is present anywhere in the output", () => {
    expect(parseMatchedFileSummary("some unrelated Stryker log noise\n")).toBeNull();
  });
});

// This is the reconciliation half of the mutation-glob fix. It went through
// two rounds:
//
//   Round 1 checked `report.files` presence/mutant-count directly. That
//   caught the six bracket-route files correctly, but a MEDIUM review
//   finding (reproduced against a real Stryker report, not hypothetically)
//   showed it ALSO hard-fails on a requested file that Stryker genuinely
//   matched but which has no mutable code at all — e.g. a pure re-export
//   barrel. `report.files` omits a file under BOTH conditions identically;
//   presence alone cannot distinguish "matched, nothing to mutate" from
//   "never matched at all".
//
//   Round 2 (this suite) switches the signal to Stryker's own file-count
//   summary (`parseMatchedFileSummary`, from its captured console output)
//   instead: if Stryker's own resolution matched at least as many files as
//   were requested, every requested file WAS targeted, and an absence from
//   `report.files` is legitimate. If it matched fewer, at least one
//   requested file was silently dropped, and the run still hard-fails.
describe("assertRequestedFilesMutated (reconciliation: closes the silent-glob-drop hole)", () => {
  it("passes when Stryker's own count confirms every requested file was matched, even though one is absent from report.files", () => {
    const report = {
      files: {
        "src/lib/areas.ts": {
          mutants: [
            {
              id: "1",
              status: "Survived",
              mutatorName: "X",
              location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
            },
          ],
        },
        // "src/lib/service/index.ts" is deliberately absent — a
        // legitimately mutant-free file, matched by its own --mutate
        // pattern, contributes zero mutants and never appears here.
      },
    };
    const strykerOutput = "Found 2 of 242 file(s) to be mutated.\n";

    expect(() =>
      assertRequestedFilesMutated(
        report,
        ["src/lib/service/index.ts", "src/lib/areas.ts"],
        strykerOutput,
      ),
    ).not.toThrow();
  });

  // The genuine-drop shape: Stryker's own count says only 1 of the 2
  // requested files was matched — the run still must not pass, and must
  // still name the file that's missing, exactly as round 1 did.
  it("throws naming a requested file that Stryker's own count confirms was never matched", () => {
    const report = {
      files: {
        "src/lib/areas.ts": {
          mutants: [
            {
              id: "1",
              status: "Survived",
              mutatorName: "X",
              location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
            },
          ],
        },
      },
    };
    const strykerOutput = "Found 1 of 243 file(s) to be mutated.\n";

    expect(() =>
      assertRequestedFilesMutated(
        report,
        ["src/lib/areas.ts", "src/app/api/items/[id]/route.ts"],
        strykerOutput,
      ),
    ).toThrow(/src\/app\/api\/items\/\[id\]\/route\.ts/);
  });

  it("throws citing the match-count shortfall in its message", () => {
    const report = { files: {} };
    const strykerOutput = "Found 0 of 5 file(s) to be mutated.\n";

    expect(() =>
      assertRequestedFilesMutated(report, ["src/a.ts", "src/b.ts"], strykerOutput),
    ).toThrow(/matched only 0 of the 2 requested file\(s\)/);
  });

  it("throws when neither summary line can be found in the captured output — refuses to trust an unverifiable run", () => {
    const report = { files: { "src/a.ts": { mutants: [{ id: "1", status: "Survived" }] } } };

    expect(() =>
      assertRequestedFilesMutated(report, ["src/a.ts"], "totally unrelated log noise\n"),
    ).toThrow(/could not verify/);
  });

  it("does nothing when the requested-files list is empty", () => {
    const report = { files: {} };
    expect(() =>
      assertRequestedFilesMutated(report, [], "Found 0 of 5 file(s) to be mutated.\n"),
    ).not.toThrow();
  });
});

// The regression fixture for the MEDIUM finding, built from REAL data, not
// synthesized: both the console text and the report shape below are copied
// verbatim from actually running
//   npx stryker run --mutate "src/lib/service/index.ts,src/lib/areas.ts" --force
// against this repository as it stands. `src/lib/service/index.ts` is a
// genuine pure re-export barrel (see that file) with zero mutable
// statements. The mutant entries under `src/lib/areas.ts` are two real
// entries copied from that run's actual `reports/mutation/mutation.json`
// (trimmed from 38 for legibility — the trimming does not change what's
// being proven, which is the barrel's absence alongside a real sibling
// file's presence, not the sibling's own mutant count).
describe("assertRequestedFilesMutated — real Stryker output regression (MEDIUM finding)", () => {
  const REAL_STRYKER_OUTPUT_BARREL_RUN =
    "[32m23:08:48 (61232) INFO ProjectReader[39m No incremental result file found at reports/stryker-incremental.json, a full mutation testing run will be performed.\n" +
    "[32m23:08:48 (61232) INFO ProjectReader[39m Found 2 of 242 file(s) to be mutated.\n" +
    "[32m23:08:49 (61232) INFO Instrumenter[39m Instrumented 2 source file(s) with 38 mutant(s)\n";

  const REAL_REPORT_BARREL_RUN = {
    schemaVersion: "1",
    thresholds: { high: 90, low: 70, break: 60 },
    testFiles: {},
    files: {
      // src/lib/service/index.ts is genuinely absent here — verified
      // against the real report; this is not an omission in the fixture.
      "src/lib/areas.ts": {
        language: "typescript",
        source: "",
        mutants: [
          {
            id: "12",
            mutatorName: "BlockStatement",
            replacement: "{}",
            status: "NoCoverage",
            static: false,
            coveredBy: [],
            location: { end: { column: 4, line: 33 }, start: { column: 28, line: 30 } },
          },
          {
            id: "13",
            mutatorName: "StringLiteral",
            replacement: "``",
            status: "NoCoverage",
            static: false,
            coveredBy: [],
            location: { end: { column: 66, line: 31 }, start: { column: 11, line: 31 } },
          },
        ],
      },
    },
  };

  // Requirement 1: the guard must NOT fail for a legitimately mutant-free
  // file. This is the exact scenario the review round's MEDIUM finding
  // reported as broken.
  it("does not fail for a real pure re-export barrel matched by Stryker but absent from report.files", () => {
    expect(() =>
      assertRequestedFilesMutated(
        REAL_REPORT_BARREL_RUN,
        ["src/lib/service/index.ts", "src/lib/areas.ts"],
        REAL_STRYKER_OUTPUT_BARREL_RUN,
      ),
    ).not.toThrow();
  });

  // Requirement 2: a real report/output pair must still catch a genuinely
  // dropped file — proving the false-alarm fix did not weaken real
  // detection. Built from a second, separate real run:
  //   npx stryker run --mutate "src/app/api/items/[id]/route.ts,src/lib/areas.ts" --force
  // (the bracket route's pattern deliberately left UNESCAPED, reproducing
  // the original bug). Real captured output: "Found 1 of 242 file(s) to be
  // mutated." — only 1 of the 2 requested files was actually matched by
  // Stryker's own resolution; `report.files` again contains only
  // `src/lib/areas.ts` (with the identical two real mutant entries — the
  // same deterministic source, force-run without incremental reuse).
  it("still fails on a real report for a genuinely dropped (unescaped bracket-route) file", () => {
    const realStrykerOutputDroppedRun =
      '[33m23:15:41 (44372) WARN ProjectReader[39m Glob pattern "src/app/api/items/[id]/route.ts" did not result in any files.\n' +
      "[32m23:15:41 (44372) INFO ProjectReader[39m Found 1 of 242 file(s) to be mutated.\n" +
      "[32m23:15:41 (44372) INFO Instrumenter[39m Instrumented 1 source file(s) with 38 mutant(s)\n";
    const realReportDroppedRun = {
      files: {
        "src/lib/areas.ts": {
          mutants: [
            {
              id: "12",
              mutatorName: "BlockStatement",
              status: "NoCoverage",
              location: { end: { column: 4, line: 33 }, start: { column: 28, line: 30 } },
            },
          ],
        },
        // src/app/api/items/[id]/route.ts is genuinely absent — its
        // --mutate pattern was never escaped in this fixture run, matching
        // zero files (the WARN line above), not merely producing zero
        // mutants.
      },
    };

    expect(() =>
      assertRequestedFilesMutated(
        realReportDroppedRun,
        ["src/app/api/items/[id]/route.ts", "src/lib/areas.ts"],
        realStrykerOutputDroppedRun,
      ),
    ).toThrow(/src\/app\/api\/items\/\[id\]\/route\.ts/);
  });
});

// Acceptance criteria 4 and 5 for the false-PASS fix: a report path is a
// real file on disk here (mkdtempSync + writeFileSync/rmSync), never a
// mocked `fs` module — these two functions exist specifically to make a
// real filesystem race (a stale file surviving a crashed run) impossible,
// so the proof has to go through a real file to mean anything.
describe("readReportOrThrow / clearReportFile (the false-PASS fix)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("AC4: throws — never returns a report — when no file exists at the path", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mutation-report-guards-"));
    const reportPath = path.join(dir, "mutation.json");

    expect(existsSync(reportPath)).toBe(false);
    expect(() => readReportOrThrow(reportPath, "--changed-only run")).toThrow(
      /--changed-only run produced no report/,
    );
  });

  it("AC4: the thrown message names which run was being checked, not just 'missing'", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mutation-report-guards-"));
    const reportPath = path.join(dir, "mutation.json");

    expect(() => readReportOrThrow(reportPath, "control run")).toThrow(/control run/);
  });

  it("AC5: clearReportFile deletes a file from a previous invocation so it cannot be read as current", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mutation-report-guards-"));
    const reportPath = path.join(dir, "mutation.json");

    // Simulate the control run's report already sitting at the shared
    // path — the exact stale-file shape that produced the false PASS.
    writeFileSync(reportPath, JSON.stringify({ files: { "stale.ts": { mutants: [] } } }), "utf8");
    expect(existsSync(reportPath)).toBe(true);

    clearReportFile(reportPath);

    expect(existsSync(reportPath)).toBe(false);
    // And with the stale file gone, a real run that then fails to write
    // its own report is correctly caught as "nothing was produced" —
    // never silently reads the deleted stale content.
    expect(() => readReportOrThrow(reportPath, "--changed-only run")).toThrow(/produced no report/);
  });

  it("AC5: after clearReportFile + a fresh write, only the freshly written content is read back", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mutation-report-guards-"));
    const reportPath = path.join(dir, "mutation.json");

    writeFileSync(reportPath, JSON.stringify({ files: { "control-fixture.ts": {} } }), "utf8");
    clearReportFile(reportPath);
    writeFileSync(reportPath, JSON.stringify({ files: { "real-run.ts": {} } }), "utf8");

    const report = readReportOrThrow(reportPath, "--changed-only run");
    expect(Object.keys(report.files)).toEqual(["real-run.ts"]);
  });

  it("clearReportFile is a no-op (does not throw) when the path does not exist", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mutation-report-guards-"));
    const reportPath = path.join(dir, "never-existed.json");

    expect(existsSync(reportPath)).toBe(false);
    expect(() => clearReportFile(reportPath)).not.toThrow();
  });

  it("reads back a well-formed report unchanged when the file does exist", () => {
    dir = mkdtempSync(path.join(tmpdir(), "mutation-report-guards-"));
    const reportPath = path.join(dir, "mutation.json");
    const shape = { thresholds: { break: 60 }, files: { "src/lib/x.ts": { mutants: [] } } };
    writeFileSync(reportPath, JSON.stringify(shape), "utf8");

    expect(readReportOrThrow(reportPath, "control run")).toEqual(shape);
  });
});

// AC5 (incremental caching): a stale or corrupt incremental cache must
// never be silently trusted. `validateIncrementalCache` is the wrapper's
// FIRST line of defence — before Stryker's own project reader ever gets a
// chance to crash opaquely on the same file (verified separately, against
// a real Stryker invocation, in the handoff brief; that path is not
// re-testable here without spawning Stryker, which is exactly what these
// synthetic-fixture tests exist to avoid).
describe("validateIncrementalCache (AC5: a bad incremental cache cannot cause a false PASS)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reports no cache and takes no action when the file does not exist — the ordinary first-run state", () => {
    dir = mkdtempSync(path.join(tmpdir(), "incremental-cache-"));
    const cachePath = path.join(dir, "stryker-incremental.json");

    const result = validateIncrementalCache(cachePath);

    expect(result).toEqual({ hadCache: false, reason: null });
    expect(existsSync(cachePath)).toBe(false);
  });

  it("deletes an unparseable cache file and reports why, rather than leaving it for Stryker to crash on", () => {
    dir = mkdtempSync(path.join(tmpdir(), "incremental-cache-"));
    const cachePath = path.join(dir, "stryker-incremental.json");
    writeFileSync(cachePath, "{ not valid json at all", "utf8");

    const result = validateIncrementalCache(cachePath);

    expect(result.hadCache).toBe(false);
    expect(result.reason).toMatch(/not valid JSON/i);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("deletes a well-formed-JSON file that isn't a recognisable report (missing `files`)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "incremental-cache-"));
    const cachePath = path.join(dir, "stryker-incremental.json");
    writeFileSync(cachePath, JSON.stringify({ notAReport: true }), "utf8");

    const result = validateIncrementalCache(cachePath);

    expect(result.hadCache).toBe(false);
    expect(result.reason).toMatch(/not a recognisable mutation-testing report/i);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("deletes a JSON array (valid JSON, but `files` cannot exist on it as an object key)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "incremental-cache-"));
    const cachePath = path.join(dir, "stryker-incremental.json");
    writeFileSync(cachePath, JSON.stringify([1, 2, 3]), "utf8");

    const result = validateIncrementalCache(cachePath);

    expect(result.hadCache).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("deletes bare JSON null (parses without throwing, but is not a report)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "incremental-cache-"));
    const cachePath = path.join(dir, "stryker-incremental.json");
    writeFileSync(cachePath, "null", "utf8");

    const result = validateIncrementalCache(cachePath);

    expect(result.hadCache).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("leaves a well-formed cache file in place and reports hadCache: true", () => {
    dir = mkdtempSync(path.join(tmpdir(), "incremental-cache-"));
    const cachePath = path.join(dir, "stryker-incremental.json");
    const shape = {
      schemaVersion: "1.0",
      files: { "src/lib/x.ts": { mutants: [] } },
      testFiles: {},
    };
    writeFileSync(cachePath, JSON.stringify(shape), "utf8");

    const result = validateIncrementalCache(cachePath);

    expect(result).toEqual({ hadCache: true, reason: null });
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual(shape);
  });
});
