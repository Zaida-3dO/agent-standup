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
    expect(GATE).toContain("exit 1");
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
