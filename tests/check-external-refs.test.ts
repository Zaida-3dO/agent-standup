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
  SKIPPED_FILES,
  findViolations,
  isScannable,
  summariseWaivers,
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
    ["temporal-changed", "Until now the rules lived in client-side scripts."],
    ["temporal-changed", "Carried over from the earlier implementation."],
    ["temporal-changed", "We are moving off a folder-of-markdown workflow."],
    ["supersession", "Replaces a folder of files plus a wrapper script."],
    ["supersession", "This is the replacement for resuming a session."],
    ["supersession", "The predecessor system had a directory per task."],
    ["supersession", "A shim so the legacy store keeps working."],
    ["ported", "Version one is a port of the board that already exists."],
    ["ported", "Ported from the scheduler that runs on each machine."],
    ["the-old-thing", "Everything the old system blocked is now a field."],
    ["the-old-thing", "The original store kept one folder per task."],
    ["the-old-thing", "Nothing here depends on the prior state of anything."],
    ["the-old-thing", "An old system had a directory for each of them."],
    ["the-old-thing", "Old scripts on each machine cannot be kept in step."],
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

  it("catches every determiner in front of `old`, not only `the`", () => {
    // Regression. The shape was written `older?`, and `?` binds to a single
    // character — so it meant "olde" plus an optional "r" and matched nothing
    // anyone writes. `\bthe old\b` was carrying the whole shape on its own,
    // which is why the hole was invisible: the commonest form was covered and
    // every other determiner went straight through.
    for (const text of [
      "an old system",
      "our old board",
      "old scripts",
      "my old setup",
      "one old way of doing it",
      "an older version",
    ]) {
      expect(ids(text)).toContain("the-old-thing");
    }
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
    "You cannot supersede a `running` assignment.",
    "Missed an existing helper, or broke an unrelated caller.",
    "Pick a host port that isn't already in use.",
    "Replace the stub with the real client.",
    "A compatibility shim, kept for one release.",
    "Import verification: row counts, spot-check report, idempotent re-run.",
    // Everything below is ordinary prose for a Next.js / Prisma / Postgres
    // repository that an over-broad pattern would flag. A check that fires
    // on correct writing gets waived, then ignored, then deleted — so these
    // are as load-bearing as the violations above.
    "`kind` is used to derive the column at read time.",
    "`DATABASE_URL` is used to connect to Postgres.",
    "Return the original error rather than wrapping it.",
    "Compare against the original commit SHA.",
    "The published port of the db container is 5432.",
    "Fill in the values for your environment.",
    "Migration seeds `legacy_id` here, which is why `id` can be opaque.",
    "The eslintrc FlatCompat legacy shim chokes on modern flat configs.",
    "Keep supporting the legacy config format for one more major.",
    "The importer moves each row into `items`.",
    // `old <noun>` is narrowed to a list of nouns that name a system. These
    // two are real lines in this repository, about its own rows and its own
    // sessions, and widening the list to catch them would flag correct prose.
    "A woken old session is told who took over rather than failing blankly.",
    "Older items keep pointing at the version they came from.",
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

  it("skips only generated files, so coverage can't be dropped by adding a name", () => {
    // Same reasoning as SELF_EXEMPT, for the other list that can silence a
    // file. Adding "README.md" here would disable scanning of the most
    // public file in the repository with the suite still green.
    expect(SKIPPED_FILES).toEqual(["package-lock.json"]);
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

  it("rejects padding that is long enough but says nothing", () => {
    // A length check alone lets this through, which satisfies the letter of
    // "say why" and none of its point.
    expect(ids("the old thing <!-- external-ref-ok: xxxxxxxxxxxx -->")).toEqual([
      "waiver-without-a-reason",
    ]);
    expect(ids("the old thing <!-- external-ref-ok: ............ -->")).toEqual([
      "waiver-without-a-reason",
    ]);
  });

  it("rejects a reason made only of words that explain nothing", () => {
    // Each of these is three words and over twelve characters, so a length
    // check and a word count both pass them — and each says exactly as much
    // as an empty waiver.
    //
    // The last fixture is the one that pins DISTINCTNESS, and it is the only
    // one that does: every other entry here is killed by the filler list on
    // its own (`todo` is filler too), so dropping the `new Set` would leave
    // them all still rejected and the suite still green. "schema schema
    // schema" is one real word padded out to three — three words, twenty
    // characters, one distinct non-filler word — so it is rejected today and
    // accepted the moment distinctness goes.
    for (const junk of [
      "this is fine",
      "TODO TODO TODO",
      "lorem ipsum dolor",
      "it is fine really",
      "just ignore this one",
      "waived for reasons",
      "this is the one",
      "schema schema schema",
    ]) {
      expect(ids(`the old thing <!-- external-ref-ok: ${junk} -->`)).toEqual([
        "waiver-without-a-reason",
      ]);
    }
  });

  it("accepts the reasons a real waiver in this repository actually gives", () => {
    // The other half of the test above, and the one that stops the filter
    // being tightened until it rejects honest waivers. The first three are
    // live waiver reasons in this repository. The fourth is not — it is the
    // template from the rules file's fenced example, which the fence rule
    // excludes from being a waiver at all — and it is here precisely because
    // it is the string a contributor copies.
    for (const real of [
      "this rule has to quote the phrasing it forbids in order to state it",
      "naming the shapes it matches is the documentation; they are grammar, not real values",
      '"no longer" is about this repository\'s own migration history, not an earlier system',
      "this one is about this repository",
    ]) {
      expect(scan(`the old thing <!-- external-ref-ok: ${real} -->`)).toEqual([]);
    }
  });

  it("a plain waiver covers its own line and no more", () => {
    // Worth pinning: the two forms differ, and getting this backwards would
    // silently widen every waiver in the repository.
    const text = [
      "<!-- external-ref-ok: this line is really about this repository -->",
      "the old board is still described here",
    ].join("\n");

    expect(scan(text).map((v) => v.line)).toEqual([2]);
  });

  it("reports how much the waivers in a file are silencing", () => {
    // A waiver covers a whole line, and a line is unbounded — one reason can
    // excuse several matches across several shapes. That is an acceptable
    // design only if it is visible, so the summary counts it.
    const wide =
      "the old board and today's ledger and the current script <!-- external-ref-ok: all three are about this repository -->";

    expect(scan(wide)).toEqual([]);
    const summary = summariseWaivers(wide) as { waivers: number; suppressed: number };
    expect(summary.waivers).toBe(1);
    expect(summary.suppressed).toBeGreaterThanOrEqual(3);
  });

  it("counts the second line a -next-line waiver covers", () => {
    const text = [
      "<!-- external-ref-ok-next-line: this one is about this repository -->",
      "the old board and today's ledger and the current script",
    ].join("\n");

    expect(scan(text)).toEqual([]);
    const summary = summariseWaivers(text) as { waivers: number; suppressed: number };
    expect(summary.waivers).toBe(1);
    expect(summary.suppressed).toBeGreaterThanOrEqual(3);
  });

  it("counts nothing when there are no waivers", () => {
    expect(summariseWaivers("the server refuses the change")).toEqual({
      waivers: 0,
      suppressed: 0,
    });
  });

  it("treats a waiver inside a fenced block as documentation, not a waiver", () => {
    // The rules file has to show the syntax to teach it. Those examples must
    // not be live, or every reader miscounts the real waivers — and worse,
    // violating text pasted into that block later would be silently excused.
    const text = [
      "```markdown",
      "<!-- external-ref-ok: why this one is really about this repository -->",
      "```",
      "the old board is described here",
    ].join("\n");

    expect(summariseWaivers(text)).toEqual({ waivers: 0, suppressed: 0 });
    expect(scan(text).map((v) => v.line)).toEqual([4]);
  });

  it("still scans inside a fence, so a violating example cannot hide there", () => {
    const text = ["```markdown", "the old board, as an example", "```"].join("\n");

    expect(scan(text).map((v) => v.patternId)).toEqual(["the-old-thing"]);
  });
});

describe("check-external-refs — shapes that straddle a line break", () => {
  // Every doc in docs/plans is hard-wrapped at ~100 columns, so a phrase
  // lands astride a break roughly as often as not. A line-at-a-time matcher
  // is blind to exactly those — a gap the width of the corpus.
  it("catches a shape split across a hard wrap", () => {
    const violations = scan("cannot drift the way the\nold per-client scripts could");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ patternId: "the-old-thing", line: 1 });
    // The rendered line shows both halves, or the message is unactionable.
    expect(violations[0]!.text).toContain("⏎");
  });

  it("reports a straddling match once, not twice", () => {
    // The same words on one line are found by the first pass; the second
    // pass must not double-report them.
    expect(scan("cannot drift the way the old per-client scripts could")).toHaveLength(1);
  });

  it("points at where the match starts, not at the start of the line", () => {
    // The second pass finds matches in the whole file flattened to one
    // string, then maps an offset in that string back to a line and column.
    // That arithmetic depends on the join separator being exactly one
    // character wide, and nothing else pins it: get it wrong and every
    // straddling match is still *reported*, just at coordinates that send the
    // reader to the wrong place. The clean lines above the straddle are
    // load-bearing — the drift only accumulates once there are earlier lines
    // to accumulate over, so a fixture starting on line 1 proves nothing.
    const lines = [
      "some clean text here",
      "another clean line",
      "cannot drift the way the",
      "old per-client scripts could",
    ];
    const [violation] = scan(lines.join("\n"));

    expect(violation).toMatchObject({ patternId: "the-old-thing", line: 3, column: 22 });
    expect(lines[2]!.slice(violation!.column - 1)).toBe("the");
  });

  it("does not weld a phrase across a blank line — that is a paragraph break, not a wrap", () => {
    // The flattening exists because a hard wrap is not a boundary in the
    // rendered text. A blank line is: it ends the paragraph, and the two
    // halves are never read as one sentence. Joining must not manufacture a
    // match out of them — which is why the separator is left alone rather
    // than collapsed to single spaces on the way in.
    const text = ["a rule lives in one place, not in the", "", "old client-side wrapper"].join(
      "\n",
    );

    expect(scan(text)).toEqual([]);
  });

  it("respects a waiver on either side of the break", () => {
    const onFirst = [
      "<!-- external-ref-ok: this wrapped line is about this repository -->",
      "cannot drift the way the",
      "old per-client scripts could",
    ].join("\n");
    // The waiver covers its own line and, being a plain waiver, not the rest —
    // but the straddle starts on line 2, so waive there instead.
    expect(scan(onFirst)).toHaveLength(1);

    const onSecond = [
      "<!-- external-ref-ok-next-line: this wrapped line is about this repo -->",
      "cannot drift the way the",
      "old per-client scripts could",
    ].join("\n");
    expect(scan(onSecond)).toEqual([]);
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
    // Reports what it did *not* read as well as what it did — coverage that
    // only ever reports success can fall silently.
    expect(result.stdout).toContain("Scanned 1 of 1 files");
  });

  it("says how many files it skipped, so coverage can't drop unnoticed", () => {
    const { dir, file } = seedFile("clean.md", "The server refuses the change.\n");
    writeFileSync(path.join(dir, "package-lock.json"), "{}\n", "utf8");

    const result = runCli([file, "package-lock.json"], dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Scanned 1 of 2 files (1 skipped");
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
