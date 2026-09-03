// Proves the changed-line attribution behind the mutation gate's verdict
// (`scripts/lib/mutation-diff-scope.mjs`).
//
// The property that matters most here is the one that kept mutation testing
// switched off: a survivor on a line the author INHERITED must never fail the
// run, while a survivor on a line the author WROTE must always fail it. Nearly
// every test below is a statement about which side of that line a mutant falls
// on, because getting it wrong in either direction destroys the gate — too
// strict and it fails honest PRs (the original `thresholds.break: 60`
// behaviour), too loose and it is decoration.
import { describe, expect, it } from "vitest";
import {
  parseChangedLineRanges,
  lineIsInRanges,
  changedLineRanges,
  splitMutantsByChangedLines,
  findingsFromSplit,
  normaliseReportPath,
  scoreOf,
} from "../scripts/lib/mutation-diff-scope.mjs";

/** Builds a minimal Stryker-report-shaped object for the split logic. */
function reportWith(files: Record<string, Array<[number, string]>>) {
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([path, mutants]) => [
        path,
        {
          mutants: mutants.map(([line, status], i) => ({
            id: `${path}-${i}`,
            status,
            mutatorName: "ConditionalExpression",
            location: { start: { line, column: 1 }, end: { line, column: 9 } },
          })),
        },
      ]),
    ),
  };
}

describe("parseChangedLineRanges", () => {
  it("collects the NEW-side range from a hunk header", () => {
    const diff = ["--- a/src/lib/a.ts", "+++ b/src/lib/a.ts", "@@ -10,3 +12,5 @@", "+added"].join(
      "\n",
    );
    expect(parseChangedLineRanges(diff).get("src/lib/a.ts")).toEqual([[12, 16]]);
  });

  // A hunk header carries two independent line numbers, and they diverge as
  // soon as a diff shifts anything. Stryker reports mutant locations against
  // the file as it now exists, so only the `+` side can be compared against
  // them; reading the `-` side would judge unrelated lines, drifting further
  // the deeper into the file you go.
  it("reads the + side of the hunk header, not the - side", () => {
    const diff = ["+++ b/src/lib/a.ts", "@@ -100,2 +5,2 @@"].join("\n");
    const ranges = parseChangedLineRanges(diff).get("src/lib/a.ts");
    expect(ranges).toEqual([[5, 6]]);
    expect(lineIsInRanges(100, ranges!)).toBe(false);
  });

  // Unified diff omits a count of 1. Defaulting a missing count to 0 instead
  // of 1 would silently drop every single-line change — the most common shape
  // of a one-line bug fix — out of the gate's scope.
  it("treats a hunk header with no explicit count as a single line", () => {
    const diff = ["+++ b/src/lib/a.ts", "@@ -3 +7 @@"].join("\n");
    expect(parseChangedLineRanges(diff).get("src/lib/a.ts")).toEqual([[7, 7]]);
  });

  // A pure deletion has no new line to hang a mutant on. Storing it would
  // produce the nonsensical range [start, start-1].
  it("contributes no range for a pure-deletion hunk", () => {
    const diff = ["+++ b/src/lib/a.ts", "@@ -10,4 +9,0 @@"].join("\n");
    expect(parseChangedLineRanges(diff).has("src/lib/a.ts")).toBe(false);
  });

  it("keeps multiple hunks in one file, and separates files", () => {
    const diff = [
      "+++ b/src/lib/a.ts",
      "@@ -1,1 +1,1 @@",
      "@@ -50,0 +60,3 @@",
      "+++ b/src/lib/b.ts",
      "@@ -1,0 +2,2 @@",
    ].join("\n");
    const ranges = parseChangedLineRanges(diff);
    expect(ranges.get("src/lib/a.ts")).toEqual([
      [1, 1],
      [60, 62],
    ]);
    expect(ranges.get("src/lib/b.ts")).toEqual([[2, 3]]);
  });

  it("ignores a deleted file's /dev/null new side", () => {
    const diff = ["+++ /dev/null", "@@ -1,5 +0,0 @@"].join("\n");
    expect(parseChangedLineRanges(diff).size).toBe(0);
  });

  it("strips the b/ prefix git puts on the new-side path", () => {
    const diff = ["+++ b/src/lib/a.ts", "@@ -1 +1 @@"].join("\n");
    expect([...parseChangedLineRanges(diff).keys()]).toEqual(["src/lib/a.ts"]);
  });
});

describe("lineIsInRanges", () => {
  it("is inclusive at both ends and false outside", () => {
    const ranges: Array<[number, number]> = [[10, 12]];
    expect(lineIsInRanges(10, ranges)).toBe(true);
    expect(lineIsInRanges(12, ranges)).toBe(true);
    expect(lineIsInRanges(9, ranges)).toBe(false);
    expect(lineIsInRanges(13, ranges)).toBe(false);
  });
});

describe("changedLineRanges", () => {
  // Null is "unknown", and the caller turns it into a hard failure. If this
  // returned an empty map instead, a broken git invocation would read as "no
  // changed lines, so nothing can be attributed, so pass" — a green required
  // check that verified nothing, which is the exact defect being fixed.
  it("returns null when git fails, rather than an empty set", () => {
    expect(changedLineRanges("origin/main", () => ({ status: 1, stdout: "" }))).toBeNull();
    expect(
      changedLineRanges("origin/main", () => ({ status: null, error: new Error("ENOENT") })),
    ).toBeNull();
  });

  it("diffs against the merge base with --unified=0", () => {
    let received: string[] = [];
    changedLineRanges("origin/main", (_cmd, args) => {
      received = args;
      return { status: 0, stdout: "+++ b/src/lib/a.ts\n@@ -1 +1 @@\n" };
    });
    // Three-dot: a commit landing on main while this branch is open is not
    // this author's work. Two-dot would attribute it to them.
    expect(received).toContain("origin/main...HEAD");
    // Default context would inflate every hunk by up to 3 untouched lines on
    // each side, letting the gate fail an author for a neighbouring line.
    expect(received).toContain("--unified=0");
  });
});

describe("splitMutantsByChangedLines", () => {
  it("puts a mutant on a changed line in `changed` and one outside in `inherited`", () => {
    const report = reportWith({
      "src/lib/a.ts": [
        [5, "Survived"],
        [50, "Survived"],
      ],
    });
    const ranges = new Map([["src/lib/a.ts", [[1, 10]] as Array<[number, number]>]]);
    const { changed, inherited } = splitMutantsByChangedLines(report, ranges);
    expect(changed.map((m) => m.line)).toEqual([5]);
    expect(inherited.map((m) => m.line)).toEqual([50]);
  });

  // A file with no entry in the ranges map was not touched at all, so every
  // mutant in it is inherited. If this defaulted to "changed", a --changed-only
  // run would fail on any file Stryker pulled in beyond the diff.
  it("treats every mutant in an untouched file as inherited", () => {
    const report = reportWith({ "src/lib/untouched.ts": [[1, "Survived"]] });
    const { changed, inherited } = splitMutantsByChangedLines(report, new Map());
    expect(changed).toEqual([]);
    expect(inherited).toHaveLength(1);
  });

  // Failing someone on a mutant nobody can point at is unattributable, and an
  // unattributable failure is what makes people stop trusting a gate.
  it("treats a mutant with no location as inherited rather than as a finding", () => {
    const report = { files: { "src/lib/a.ts": { mutants: [{ status: "Survived" }] } } };
    const ranges = new Map([["src/lib/a.ts", [[1, 100]] as Array<[number, number]>]]);
    const { changed, inherited } = splitMutantsByChangedLines(report as never, ranges);
    expect(changed).toEqual([]);
    expect(inherited).toHaveLength(1);
  });

  // A Windows report path must still match git's forward-slashed relative
  // path. If it did not, the split would find no ranges for any file and
  // report a clean gate for a filthy diff — on one platform only.
  it("matches a Windows-style absolute report path against a git-relative path", () => {
    const report = reportWith({ "C:\\repo\\src\\lib\\a.ts": [[5, "Survived"]] });
    const ranges = new Map([["src/lib/a.ts", [[1, 10]] as Array<[number, number]>]]);
    const { changed } = splitMutantsByChangedLines(report, ranges);
    expect(changed).toHaveLength(1);
    expect(changed[0].filePath).toBe("src/lib/a.ts");
  });
});

describe("findingsFromSplit", () => {
  it("reports a survivor on a changed line", () => {
    const split = { changed: [{ status: "Survived" }], inherited: [] };
    expect(findingsFromSplit(split as never)).toHaveLength(1);
  });

  // The whole point of the policy. A pre-existing weak file must be able to
  // sit in the same run as a good change without failing it.
  it("never reports an inherited survivor, however many there are", () => {
    const split = {
      changed: [{ status: "Killed" }],
      inherited: [{ status: "Survived" }, { status: "Survived" }, { status: "NoCoverage" }],
    };
    expect(findingsFromSplit(split as never)).toEqual([]);
  });

  // Otherwise the easiest way to pass the gate is to add code no test calls —
  // strictly worse than a test that runs the line and fails to assert on it.
  it("reports NoCoverage on a changed line as a finding", () => {
    const split = { changed: [{ status: "NoCoverage" }], inherited: [] };
    expect(findingsFromSplit(split as never)).toHaveLength(1);
  });

  it("does not report a killed or ignored mutant", () => {
    const split = {
      changed: [{ status: "Killed" }, { status: "Timeout" }, { status: "Ignored" }],
      inherited: [],
    };
    expect(findingsFromSplit(split as never)).toEqual([]);
  });
});

describe("normaliseReportPath", () => {
  it("reduces an absolute path to its src-relative form", () => {
    expect(normaliseReportPath("/home/runner/work/repo/src/lib/a.ts")).toBe("src/lib/a.ts");
    expect(normaliseReportPath("C:\\r\\src\\lib\\a.ts")).toBe("src/lib/a.ts");
  });

  it("leaves a path with no src/ segment alone apart from separators", () => {
    expect(normaliseReportPath("scripts\\x.mjs")).toBe("scripts/x.mjs");
  });
});

describe("scoreOf", () => {
  it("counts Timeout as killed, matching computeMutationScore", () => {
    expect(scoreOf([{ status: "Killed" }, { status: "Timeout" }] as never)).toBe(100);
  });

  it("excludes NoCoverage and Ignored from the denominator", () => {
    // 1 killed of 2 scoreable = 50, not 25 — NoCoverage/Ignored are not scored.
    const mutants = [
      { status: "Killed" },
      { status: "Survived" },
      { status: "NoCoverage" },
      { status: "Ignored" },
    ];
    expect(scoreOf(mutants as never)).toBe(50);
  });

  // "No mutants" is not a score. Rendering it as 0 would fail a clean run and
  // as 100 would pass an empty one.
  it("returns null for an empty scope rather than 0 or 100", () => {
    expect(scoreOf([])).toBeNull();
    expect(scoreOf([{ status: "Ignored" }] as never)).toBeNull();
  });
});
