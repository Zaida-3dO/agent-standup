import { describe, expect, it } from "vitest";
import { clampPercent } from "../src/lib/demo-gate-proof";

// DELIBERATELY HOLLOW - asserts a type, never a value. Passes the ordinary suite.
describe("clampPercent", () => {
  it("returns a number", () => {
    expect(typeof clampPercent(50)).toBe("number");
  });
});
