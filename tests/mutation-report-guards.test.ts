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

// This is the reconciliation half of the mutation-glob fix: proves that a
// changed-files scope which silently resolved to zero mutants for one of
// its requested files — the exact shape Stryker produced for the six
// bracket-route files (`src/app/api/items/[id]/route.ts` and siblings)
// before the escaping fix in `mutation-scope.mjs` — is caught here, not
// silently treated as a pass. The fixture shapes below reproduce a REAL
// report observed from a live `stryker run --mutate
// "src/lib/areas.ts,src/app/api/items/[id]/route.ts"` (unescaped): only
// `src/lib/areas.ts` ever appears in `report.files`; the bracket route is
// entirely absent, with no warning or marker anywhere in the report.
describe("assertRequestedFilesMutated (reconciliation: closes the silent-glob-drop hole)", () => {
  it("passes silently when every requested file appears in the report with at least one mutant", () => {
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
        "src/app/api/items/[id]/route.ts": {
          mutants: [
            {
              id: "2",
              status: "Survived",
              mutatorName: "X",
              location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
            },
          ],
        },
      },
    };

    expect(() =>
      assertRequestedFilesMutated(report, ["src/lib/areas.ts", "src/app/api/items/[id]/route.ts"]),
    ).not.toThrow();
  });

  // The exact real-world shape: a bracket route's `--mutate` pattern
  // silently matched zero files, so it never appears in `report.files` at
  // all — while a sibling valid file's pattern matched fine, keeping
  // `report.files` non-empty and the run from crashing outright.
  it("throws naming a requested file that is entirely absent from the report", () => {
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

    expect(() =>
      assertRequestedFilesMutated(report, ["src/lib/areas.ts", "src/app/api/items/[id]/route.ts"]),
    ).toThrow(/src\/app\/api\/items\/\[id\]\/route\.ts/);
  });

  it("throws naming a requested file that is present but has zero mutants generated for it", () => {
    const report = {
      files: {
        "src/lib/areas.ts": { mutants: [] },
      },
    };

    expect(() => assertRequestedFilesMutated(report, ["src/lib/areas.ts"])).toThrow(
      /zero mutants were generated/,
    );
  });

  it("reports every missing file, not just the first", () => {
    const report = { files: {} };

    expect(() => assertRequestedFilesMutated(report, ["src/a.ts", "src/b.ts"])).toThrow(
      /2 requested file\(s\)/,
    );
  });

  it("does nothing when the requested-files list is empty", () => {
    const report = { files: {} };
    expect(() => assertRequestedFilesMutated(report, [])).not.toThrow();
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
