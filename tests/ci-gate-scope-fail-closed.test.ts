// Two required checks in `.github/workflows/ci.yml` — `Actionlint
// (required)` and `Docker build (required)` —
// decide their verdict from a string another job produced
// (`needs.changes.outputs.*`). That string is `'true'` or `'false'` only when
// the `changes` job ran to completion. A job that errors publishes **no**
// outputs, and a missing output reads as the empty string.
//
// The failure this test exists to prevent: when every step in a gate tests
// equality against `'true'` or `'false'`, an empty value matches nothing, no
// step runs, and the job reports SUCCESS by default — a required check
// passing having verified nothing at all. It fails open, which is worse than
// not existing, because the green tick is indistinguishable from a real pass.
//
// So each gate must carry a branch that fails on any value it does not
// recognise. These assertions check that branch is present and is the shape
// that actually catches an empty string.
//
// **What a green run here does and does not mean.** This reads the workflow's
// conditions as text.
// It proves each gate is *configured* with a fail-closed branch; it does not
// run GitHub Actions' expression evaluator, so it cannot prove the runner
// agrees with this reading of an `if:`. It is a backstop against the specific
// regression above — a gate whose branches are exhaustive only over the happy
// values — not a simulation of the pipeline.
import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { extractJobBlock, extractStepBlock } from "./helpers/ci-workflow-blocks";

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

const WORKFLOW = readFileSync(path.join(repoRoot(), ".github/workflows/ci.yml"), "utf8");

/**
 * Every gate job, paired with the `changes` output whose scope it consumes.
 * Kept as data so that adding a third gate without its fail-closed branch is
 * a one-line test edit that then fails, rather than a gap nobody notices.
 */
const GATES = [
  { job: "actionlint-gate", output: "workflows", checkName: "Actionlint (required)" },
  { job: "docker-build-gate", output: "docker", checkName: "Docker build (required)" },
] as const;

/** The `if:` conditions inside a job block, with whitespace and folding flattened. */
function conditionsOf(block: string): string[] {
  return [...block.matchAll(/if:\s*(?:>-\s*\n)?((?:.|\n)*?)(?=\n\s*(?:run|name|-|\w+):)/g)]
    .map((match) => (match[1] ?? "").replace(/\s+/g, " ").trim())
    .filter((condition) => condition.length > 0);
}

describe("every required gate fails closed when the changes job reports no usable scope", () => {
  for (const { job, output, checkName } of GATES) {
    describe(job, () => {
      const block = extractJobBlock(WORKFLOW, job);

      it("finds the gate job, so the assertions below are not vacuous", () => {
        // Guards the guard: an empty block would make the `some(...)`
        // assertions below trivially false and the `not.toContain` ones
        // trivially true, so this has to be checked first.
        expect(block).not.toBe("");
        expect(block).toContain(checkName);
      });

      it("has a branch that fires on any value other than 'true' or 'false'", () => {
        // The fix. `!= 'true' && != 'false'` is true for the empty string an
        // errored upstream job leaves behind, and false for both good values
        // — so it is exactly the "I cannot interpret this scope" branch.
        //
        // Deliberately asserted as a conjunction of two inequalities rather
        // than by matching some looser shape: `!= 'true'` alone would fire on
        // a legitimate `'false'`, and `== ''` alone would miss any other
        // unexpected value.
        const failsOnUnknownScope = conditionsOf(block).some(
          (condition) =>
            condition.includes(`needs.changes.outputs.${output} != 'true'`) &&
            condition.includes(`needs.changes.outputs.${output} != 'false'`) &&
            condition.includes("&&"),
        );
        expect(failsOnUnknownScope).toBe(true);
      });

      it("exits non-zero on that branch rather than only logging", () => {
        // A branch that runs but does not fail leaves the job green, which is
        // the very outcome this is meant to stop. The `exit 1` has to be in
        // the same run block as the diagnostic echoes.
        //
        // Scoped to the fail-closed step alone. The previous version of this
        // assertion was a lazy regex running from the `if:` to the next
        // `exit 1` anywhere below it; because every gate carries a later
        // `Fail — <job> failed` step ending in `exit 1`, deleting *this*
        // step's `exit 1` still matched, and the test passed on the exact
        // regression it names (#129). `extractStepBlock` stops at the next
        // `- name:`, so the only `exit 1` it can see is this step's own.
        const failClosedStep = extractStepBlock(block, `needs.changes.outputs.${output} != 'true'`);
        expect(failClosedStep).not.toBe("");
        expect(failClosedStep).toContain("exit 1");
      });

      it("still passes cleanly when the scope is a genuine 'false'", () => {
        // The other half. Fail-closed must not become fail-always: a real
        // "nothing relevant changed" result has to keep passing, or the gate
        // blocks every unrelated pull request.
        const passesOnFalse = conditionsOf(block).some((condition) =>
          condition.includes(`needs.changes.outputs.${output} == 'false'`),
        );
        expect(passesOnFalse).toBe(true);
      });

      it("still fails when the scope is 'true' and the upstream job did not succeed", () => {
        // And the gate's original purpose has to survive the new branch.
        const failsOnRealFailure = conditionsOf(block).some(
          (condition) =>
            condition.includes(`needs.changes.outputs.${output} == 'true'`) &&
            condition.includes("!= 'success'"),
        );
        expect(failsOnRealFailure).toBe(true);
      });

      it("always runs, so an errored dependency cannot skip the required check itself", () => {
        // A required check that is itself skipped never reports at all, which
        // reads as quiet rather than red — the same trap as a pull request
        // opened against a non-main branch.
        expect(block).toMatch(/if:\s*always\(\)/);
      });

      it("declares the changes job as a dependency, or its outputs are always empty", () => {
        expect(block).toMatch(/needs:\s*\[changes,/);
      });
    });
  }
});

describe("the gate list itself", () => {
  it("covers every job in the workflow whose name ends in '(required)'", () => {
    // Stops the table above from silently going stale. A fourth required gate
    // added without an entry here would otherwise never be checked for the
    // fail-open shape — which is precisely how the first three acquired it.
    const declaredNames = new Set(GATES.map((gate) => gate.checkName));
    const requiredNames = [...WORKFLOW.matchAll(/^\s*name:\s*(.+\(required\))\s*$/gm)].map(
      (match) => (match[1] ?? "").trim(),
    );

    expect(requiredNames.length).toBeGreaterThan(0);
    for (const name of requiredNames) {
      expect(declaredNames).toContain(name);
    }
  });
});
