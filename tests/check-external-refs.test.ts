import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Plain JS, deliberately: this has to run as `node scripts/check-external-refs.mjs`
// with no build step, so CI can gate on it before anything is compiled. Types are
// inferred by `allowJs`, which is why the shapes below are asserted rather than typed.
import {
  PATTERNS,
  SELF_EXEMPT,
  findViolations,
  isScannable,
} from "../scripts/check-external-refs.mjs";

type Violation = {
  line: number;
  column: number;
  patternId: string;
  match: string;
  text: string;
  kind: string;
};

const scan = (text: string): Violation[] => findViolations(text) as Violation[];
const ids = (text: string) => scan(text).map((v) => v.patternId);

const scriptPath = path.resolve(import.meta.dirname, "../scripts/check-external-refs.mjs");

/**
 * Run the checker as CI runs it — a real process, over real files — and hand
 * back the exit code plus both streams. The unit tests below cover matching;
 * this covers the thing that actually gates a build.
 */
function runCli(files: string[], cwd: string) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...files], {
      cwd,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

const tempDirs: string[] = [];
function seedFile(name: string, contents: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "external-refs-"));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, name), contents, "utf8");
  return { dir, file: name };
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("check-external-refs — what it catches", () => {
  // Each entry is the shape of a sentence that has to fail: something a reader
  // of this repository cannot verify because it lives outside it. Written as
  // grammar, never as the real names — see the header of the script.
  const violating: Array<[string, string]> = [
    ["temporal-today", "Today the rules live somewhere else."],
    ["temporal-today", "A port of today's board, reading from the database."],
    ["temporal-now", "The rules currently live in a client-side script."],
    ["temporal-now", "At present the board is rendered from files."],
    ["temporal-past", "Previously this was enforced by a wrapper."],
    ["temporal-past", "Historically the gate ran on the client."],
    ["temporal-changed", "The store used to be a directory tree."],
    ["temporal-changed", "That constraint no longer applies."],
    ["supersession", "Replaces a folder of files plus a wrapper script."],
    ["supersession", "This is the replacement for resuming a session."],
    ["ported", "Version one is a port of the board that already exists."],
    ["the-old-thing", "Everything the old system blocked is now a field."],
    ["the-old-thing", "The original folders survive as an archive."],
    ["the-existing-thing", "Model it on the existing MCP server."],
    ["the-existing-thing", "It reads from an existing setup on that machine."],
    ["the-current-thing", "The current script does this already."],
    ["the-new-thing", "In the new app the rules are enforced."],
    ["cutover", "M5 is the board, and the cutover."],
    ["someones-own-setup", "Something the user's setup cannot do at all."],
    ["someones-own-setup", "Which part of your world this concerns."],
    ["foreign-script-file", "The tick fires from a-script.ps1 on every call."],
  ];

  it.each(violating)("fails on a %s shape: %s", (patternId, text) => {
    expect(ids(text)).toContain(patternId);
  });

  it("reports the line, the column and the text that matched", () => {
    const [violation] = scan("clean first line\nand then the old system\n");

    expect(violation).toMatchObject({
      line: 2,
      patternId: "the-old-thing",
      match: "the old",
      kind: "external-ref",
    });
    // The column points at the match, not at the start of the line — a
    // failure message that says "somewhere on line 2" is one people skim.
    expect(violation!.text.slice(violation!.column - 1)).toMatch(/^the old/);
  });

  it("catches every occurrence on a line, not just the first", () => {
    expect(ids("the old board and the old ledger")).toEqual(["the-old-thing", "the-old-thing"]);
  });

  it("matches regardless of case", () => {
    expect(ids("TODAY the rules live elsewhere")).toContain("temporal-today");
    expect(ids("Replaces the wrapper")).toContain("supersession");
  });

  it("has a stated reason for every pattern, because the message is the point", () => {
    for (const pattern of PATTERNS as Array<{ id: string; why: string }>) {
      expect(pattern.why.length).toBeGreaterThan(20);
    }
  });
});

describe("check-external-refs — what it must not flag", () => {
  // The failure mode of a check like this is being too noisy to keep, so
  // these are the in-repo sentences it has to leave alone. Each one is
  // phrasing that appears, or plausibly would appear, in this repository.
  const clean = [
    "The rules live in the backend and are enforced, not requested.",
    "A one-time import from an external file-based store.",
    "Only share an existing instance if there's a specific reason to.",
    "Rows are kept, not deleted — this is `previous_sessions`.",
    "Writing the previous row on every insert is a second write and a race.",
    "An approving code-review artifact at the current max(review_round).",
    "Reject it and name the current holder.",
    "Liveness is `running`, `stalled`, `dead` or `superseded`.",
    "Missed an existing helper, or broke an unrelated caller.",
    "Pick a host port that isn't already in use.",
    "Replace the stub with the real client.",
    "A compatibility shim, kept for one release.",
    "Import verification: row counts, spot-check report, idempotent re-run.",
  ];

  it.each(clean)("leaves this alone: %s", (text) => {
    expect(scan(text)).toEqual([]);
  });

  it("skips binary files and lockfiles rather than reading them", () => {
    expect(isScannable("docs/plans/PLAN.md")).toBe(true);
    expect(isScannable("src/app/page.tsx")).toBe(true);
    expect(isScannable("package-lock.json")).toBe(false);
    expect(isScannable("public/screenshot.png")).toBe(false);
  });

  it("exempts only the two files that must contain the shapes", () => {
    // One defines the patterns, the other proves they are caught. If this
    // list ever grows, the growth is the bug: an exemption list that can be
    // extended quietly is a slower way of deleting the check.
    expect(SELF_EXEMPT).toEqual([
      "scripts/check-external-refs.mjs",
      "tests/check-external-refs.test.ts",
    ]);
    for (const exempt of SELF_EXEMPT as string[]) {
      expect(isScannable(exempt)).toBe(false);
    }
  });
});

describe("check-external-refs — waivers", () => {
  it("a same-line waiver silences that line", () => {
    expect(
      scan("the old commit is still there <!-- external-ref-ok: this repo's own git history -->"),
    ).toEqual([]);
  });

  it("a next-line waiver silences the line after it", () => {
    const text = [
      "<!-- external-ref-ok-next-line: describes this repository's own drift check -->",
      "replaying the migration history no longer reproduces the schema",
    ].join("\n");

    expect(scan(text)).toEqual([]);
  });

  it("a next-line waiver silences only the next line", () => {
    const text = [
      "<!-- external-ref-ok-next-line: covers the migration note below -->",
      "no longer reproduces the committed schema",
      "and the old system did it differently",
    ].join("\n");

    expect(scan(text).map((v) => v.line)).toEqual([3]);
  });

  it("works in a line comment as well as an HTML comment", () => {
    expect(scan("// external-ref-ok: this is about this repository's history")).toEqual([]);
  });

  it("rejects a waiver with no reason — silencing the check has to cost an explanation", () => {
    const violations = scan("the old thing <!-- external-ref-ok: -->");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      patternId: "waiver-without-a-reason",
      kind: "empty-waiver",
    });
  });

  it("rejects a waiver whose reason is too short to be a reason", () => {
    expect(ids("the old thing <!-- external-ref-ok: fine -->")).toEqual([
      "waiver-without-a-reason",
    ]);
  });
});

describe("check-external-refs — as CI runs it", () => {
  it("exits non-zero and names the file, line and shape", () => {
    const { dir, file } = seedFile(
      "seeded.md",
      "# Notes\n\nIt replaces the old folder-based store.\n",
    );

    const result = runCli([file], dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("seeded.md:3");
    expect(result.stderr).toContain("[supersession]");
    expect(result.stderr).toContain("[the-old-thing]");
    // The failure has to say how to record a deliberate exception, or the
    // only thing anyone learns from it is how to skip the step.
    expect(result.stderr).toContain("external-ref-ok");
  });

  it("exits zero on clean text and says how much it looked at", () => {
    const { dir, file } = seedFile(
      "clean.md",
      "# Notes\n\nThe rules live in the backend and the server refuses the change.\n",
    );

    const result = runCli([file], dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Scanned 1 files");
  });

  it("passes over this repository as it stands", () => {
    // The whole point of landing the sweep and the check together: the
    // check is not merely runnable, it is green on the tree it ships with.
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const result = runCli([], repoRoot);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
