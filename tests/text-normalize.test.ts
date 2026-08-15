// `normalizeEmDash` — MILESTONES.md #113's third part, the deliberate
// house-style normalisation, kept separate from the encoding-fault work the
// rest of #113 is about. See `src/lib/text-normalize.ts` for why it is
// scoped to the em dash only.
import { describe, expect, it } from "vitest";
import { normalizeEmDash } from "@/lib/text-normalize";

describe("normalizeEmDash", () => {
  it("rewrites a single em dash to a plain hyphen", () => {
    expect(normalizeEmDash("Ship it — quickly")).toBe("Ship it - quickly");
  });

  it("rewrites every em dash in a string, one each — not just the first", () => {
    expect(normalizeEmDash("a — b — c")).toBe("a - b - c");
  });

  it("leaves a string with no em dash completely unchanged", () => {
    // The rejection-path equivalent for a pure normaliser: proves the
    // function is not blindly rewriting every dash-shaped character, only
    // the one it claims to target.
    const untouched = "a plain title, no dashes at all";
    expect(normalizeEmDash(untouched)).toBe(untouched);
  });

  it("does NOT touch an en dash (U+2013) — a different character with a different common meaning", () => {
    // Would fail if the implementation were widened to "any dash-like
    // character" rather than the em dash specifically — the exact
    // over-normalisation `text-normalize.ts`'s header warns against.
    expect(normalizeEmDash("2024–2026")).toBe("2024–2026");
  });

  it("does NOT touch a plain ASCII hyphen-minus — already the target form, nothing to do", () => {
    expect(normalizeEmDash("already-hyphenated")).toBe("already-hyphenated");
  });

  it("does NOT touch a minus sign (U+2212) or a figure dash (U+2012) — only the exact em dash character", () => {
    expect(normalizeEmDash("x − y")).toBe("x − y");
    expect(normalizeEmDash("07‒12")).toBe("07‒12");
  });

  it("handles an em dash at the very start or end of the string", () => {
    expect(normalizeEmDash("— leading")).toBe("- leading");
    expect(normalizeEmDash("trailing —")).toBe("trailing -");
  });

  it("is a no-op on an empty string", () => {
    expect(normalizeEmDash("")).toBe("");
  });

  it("does not merge adjacent words — the em dash is swapped for a hyphen, never dropped", () => {
    // Guards against an implementation that stripped the character
    // entirely, which would silently glue the two words together.
    const result = normalizeEmDash("go—now");
    expect(result).toBe("go-now");
    expect(result).not.toBe("gonow");
  });
});
