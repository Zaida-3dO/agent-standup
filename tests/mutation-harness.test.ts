// Exercises `mutation-control.ts` just enough to give the mutation-testing
// harness's control check something to run coverage analysis against — see
// `scripts/run-mutation-tests.mjs` (`assertControlSurvives`) for what this
// backs. This is NOT a behavioural test of application logic; it exists so
// `controlNoOp` has a covering test at all, which per-test coverage
// analysis requires before Stryker will even attempt to mutate it.
import { describe, expect, it } from "vitest";
import { controlNoOp } from "@/lib/mutation-control";

describe("controlNoOp (mutation-harness control fixture)", () => {
  it("returns its input unchanged for real string values", () => {
    expect(controlNoOp("anything")).toBe("anything");
    expect(controlNoOp("")).toBe("");
  });
});
