// The `mutation-testing-gate` job in `.github/workflows/ci.yml` is a required
// check, and it decides its verdict from the `mutation-testing` job's
// `result` rather than from running anything itself. That makes it entirely a
// matter of which result values it treats as acceptable — and getting that
// wrong is invisible until a pull request is blocked by it.
//
// The failure this test exists to prevent, because it happened: the gate
// failed on `needs.mutation-testing.result != 'success'`, which is true for
// `skipped` as well as `failure`. While the mutation job is paused it reports
// `skipped` on every source change, so every pull request touching `src/`
// carried a red required check that no change to the pull request could
// clear. The pause and the gate were each individually correct and did not
// work together.
//
// **What a green run here does and does not mean.** These assertions read the
// workflow's own conditions as text and check which result values each step
// reacts to. That proves the gate is *configured* to distinguish `skipped`
// from `failure`; it does not execute GitHub Actions' expression evaluator,
// so it cannot prove the runner agrees with this reading of an `if:`. It is a
// backstop against the specific regression above — a condition that lumps the
// two together — not a simulation of the pipeline.
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function leadingSpaces(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? (match[1]?.length ?? 0) : 0;
}

/**
 * The text of one top-level job block, from its key line to the next key at
 * the same indentation. Scoped rather than searched whole-file so that a
 * condition belonging to a *different* job cannot satisfy an assertion about
 * this one — the same reason `ci-docker-paths-filter.test.ts` walks the
 * structure instead of substring-matching.
 */
export function extractJobBlock(yamlText: string, jobKey: string): string {
  const lines = yamlText.split("\n");
  const startIndex = lines.findIndex((line) => new RegExp(`^\\s*${jobKey}:\\s*$`).test(line));
  if (startIndex === -1) return "";

  const indent = leadingSpaces(lines[startIndex] ?? "");
  const block: string[] = [lines[startIndex] ?? ""];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() !== "" && leadingSpaces(line) <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

/**
 * The text of the single step within `jobBlock` whose `if:` condition contains
 * `conditionNeedle`, from its `- name:` line to the next step at the same
 * indentation. Returns `""` when no such step exists.
 *
 * Why this is structural rather than a regex: the assertion it serves is "this
 * step's own `run:` block exits non-zero", and a regex spanning from an `if:`
 * to the next `exit 1` does not express that. A lazy `(?:.|\n)*?exit 1` will
 * happily cross into a *later* step and match that step's `exit 1` — which is
 * exactly how the previous version of this assertion came to be defeatable by
 * deleting the very line it was written to require (#129). Walking to the step
 * boundary makes the scope a property of the parser rather than a hope about
 * the input.
 */
export function extractStepBlock(jobBlock: string, conditionNeedle: string): string {
  const lines = jobBlock.split("\n");
  // Step starts are `- name:` entries; collect their indices so a step can be
  // bounded by the next one rather than by whatever text happens to follow.
  const stepStarts = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*-\s+name:/.test(line))
    .map(({ index }) => index);

  for (let i = 0; i < stepStarts.length; i += 1) {
    const start = stepStarts[i] ?? 0;
    const end = stepStarts[i + 1] ?? lines.length;
    const stepLines = lines.slice(start, end);
    const step = stepLines.join("\n");
    // Only an `if:` match counts. Matching anywhere in the step would let a
    // diagnostic `echo` quoting the condition stand in for the condition.
    // Folded scalars (`if: >-` continued on following lines) are joined back
    // into one line first — the mutation gate's failing step is written that
    // way, and a single-line regex silently finds nothing there.
    const ifIndex = stepLines.findIndex((line) => /^\s*if:/.test(line));
    if (ifIndex === -1) continue;
    const ifLine = stepLines[ifIndex] ?? "";
    let condition = ifLine.replace(/^\s*if:\s*/, "");
    if (/^[>|][-+]?$/.test(condition.trim())) {
      const foldedIndent = leadingSpaces(ifLine);
      condition = "";
      for (const line of stepLines.slice(ifIndex + 1)) {
        if (line.trim() === "") break;
        if (leadingSpaces(line) <= foldedIndent) break;
        condition += ` ${line.trim()}`;
      }
    }
    if (condition.replace(/\s+/g, " ").includes(conditionNeedle)) return step;
  }
  return "";
}

const WORKFLOW = readFileSync(path.join(repoRoot(), ".github/workflows/ci.yml"), "utf8");
const GATE = extractJobBlock(WORKFLOW, "mutation-testing-gate");

/** The `if:` conditions inside the gate, with whitespace and folding flattened. */
function gateConditions(): string[] {
  return [...GATE.matchAll(/if:\s*(?:>-\s*\n)?((?:.|\n)*?)(?=\n\s*(?:run|name|-|\w+):)/g)]
    .map((match) => (match[1] ?? "").replace(/\s+/g, " ").trim())
    .filter((condition) => condition.length > 0);
}

describe("the block this test reads", () => {
  it("finds the gate job and does not run vacuously", () => {
    // Guards the guard: every assertion below is about the contents of
    // GATE, so an empty GATE would make several of them trivially true.
    expect(GATE).not.toBe("");
    expect(GATE).toContain("Mutation testing (required)");
  });

  it("scopes to the gate rather than the whole workflow", () => {
    // The mutation job itself must not be inside the block, or a condition
    // of *its* could satisfy an assertion meant for the gate.
    expect(GATE).not.toContain("npm run test:mutate:changed");
  });
});

describe("the gate distinguishes a paused job from a failing one", () => {
  it("has a step that passes specifically on a skipped result", () => {
    // The fix. Without a branch naming `skipped`, a paused job blocks every
    // source-touching pull request.
    const passesOnSkipped = gateConditions().some(
      (condition) =>
        condition.includes("needs.mutation-testing.result == 'skipped'") &&
        condition.includes("needs.changes.outputs.source == 'true'"),
    );
    expect(passesOnSkipped).toBe(true);
  });

  it("never fails on a result of skipped", () => {
    // The assertion that would have caught the original bug. The failing
    // step's condition must exclude `skipped`; a bare
    // `result != 'success'` does not, and this is exactly that check.
    const failingStep = gateConditions().find((condition) => condition.includes("!= 'success'"));
    expect(failingStep).toBeDefined();
    expect(failingStep).toContain("!= 'skipped'");
  });

  it("still fails when mutation testing ran and did not succeed", () => {
    // The other half, and the one that must not be softened: a gate that
    // forgave a real failure because some other run had been paused would
    // be worse than no gate at all.
    expect(GATE).toMatch(/needs\.mutation-testing\.result\s*!=\s*'success'/);

    // Scoped to the failing step itself. A bare `GATE.toContain("exit 1")`
    // passes on any `exit 1` anywhere in the job, including one belonging to a
    // different step — so it survived deleting this step's own `exit 1` (#129).
    const failingStep = extractStepBlock(GATE, "needs.mutation-testing.result != 'success'");
    expect(failingStep).not.toBe("");
    expect(failingStep).toContain("exit 1");
  });

  it("passes without qualification when no source files changed", () => {
    const passesOnNoSource = gateConditions().some(
      (condition) => condition === "needs.changes.outputs.source == 'false'",
    );
    expect(passesOnNoSource).toBe(true);
  });

  it("always runs, so a skipped dependency cannot skip the required check itself", () => {
    // A required check that is itself skipped never reports, which reads as
    // quiet rather than red — the same trap CLAUDE.md names for a pull
    // request opened against a non-main branch.
    expect(GATE).toMatch(/if:\s*always\(\)/);
  });

  it("depends on both the changes job and the mutation job", () => {
    expect(GATE).toMatch(/needs:\s*\[changes,\s*mutation-testing\]/);
  });
});

describe("extractJobBlock", () => {
  it("returns an empty string for a job that is not there", () => {
    expect(extractJobBlock(WORKFLOW, "no-such-job")).toBe("");
  });

  it("stops at the next job rather than running to the end of the file", () => {
    const changes = extractJobBlock(WORKFLOW, "changes");
    expect(changes).not.toBe("");
    expect(changes).not.toContain("mutation-testing-gate:");
  });
});

describe("extractStepBlock", () => {
  // This helper is now what makes the fail-closed assertions non-defeatable,
  // so it carries its own tests: an extractor that silently over-reached would
  // reintroduce #129 while every assertion above still read as scoped.
  const TWO_STEPS = [
    "    steps:",
    "      - name: Fail — no usable scope",
    "        if: needs.changes.outputs.docker != 'true'",
    "        run: |",
    '          echo "::error::unusable"',
    "      - name: Fail — docker-build failed",
    "        if: needs.docker-build.result != 'success'",
    "        run: exit 1",
  ].join("\n");

  it("does not reach past the end of its step", () => {
    // The regression itself. The first step has no `exit 1`; the second does.
    // A scan that crossed the boundary would return text containing it.
    const step = extractStepBlock(TWO_STEPS, "needs.changes.outputs.docker != 'true'");
    expect(step).not.toBe("");
    expect(step).toContain("::error::unusable");
    expect(step).not.toContain("exit 1");
  });

  it("returns the step's own body when it does exit non-zero", () => {
    const step = extractStepBlock(TWO_STEPS, "needs.docker-build.result != 'success'");
    expect(step).toContain("exit 1");
    expect(step).not.toContain("::error::unusable");
  });

  it("returns an empty string when no step carries the condition", () => {
    expect(extractStepBlock(TWO_STEPS, "needs.changes.outputs.nonesuch == 'true'")).toBe("");
  });

  it("reads a folded `if: >-` condition spanning several lines", () => {
    // The mutation gate's failing step is written this way. A single-line
    // regex finds nothing there and the assertion using it would fail on
    // correct YAML — which is how this helper's first draft behaved.
    const folded = [
      "      - name: Fail — mutation testing ran and did not pass",
      "        if: >-",
      "          needs.changes.outputs.source == 'true' &&",
      "          needs.mutation-testing.result != 'success'",
      "        run: exit 1",
    ].join("\n");
    expect(extractStepBlock(folded, "needs.mutation-testing.result != 'success'")).toContain(
      "exit 1",
    );
  });

  it("matches on the step's `if:` rather than anywhere in the step", () => {
    // A diagnostic echo that quotes a condition must not stand in for the
    // condition — otherwise a step could claim a branch it does not guard.
    const echoOnly = [
      "      - name: Diagnose",
      "        if: always()",
      "        run: echo \"needs.changes.outputs.docker != 'true'\"",
    ].join("\n");
    expect(extractStepBlock(echoOnly, "needs.changes.outputs.docker != 'true'")).toBe("");
  });
});
