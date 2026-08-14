// Write-time validation of `hook.allow_patterns` / `hook.ask_patterns`.
//
// Each entry is matched as a regular expression against observed command
// text on a path that runs on **every tool call**, so a pattern that cannot
// compile has to be refused at the settings write that introduces it rather
// than discovered on the hot path. The validation exists and works; what it
// shipped without is any coverage, which left the guarantee resting on
// untested code and the branches marked as having none.
//
// Both directions are asserted here, because only the pair says anything: a
// validator that accepted everything would pass the acceptance cases, and
// one that rejected everything would pass the refusals.
import { describe, expect, it } from "vitest";
import { hookPatternListSchema } from "@/lib/settings/hook-pattern";
import { validateSetting } from "@/lib/settings";

/** The parse result as a plain boolean, for the many single-value cases. */
const accepts = (patterns: unknown): boolean => hookPatternListSchema.safeParse(patterns).success;

describe("hook pattern lists — what they accept", () => {
  it("accepts an empty list, which is the default", () => {
    expect(accepts([])).toBe(true);
  });

  it("accepts an ordinary pattern", () => {
    expect(accepts(["^git status$"])).toBe(true);
  });

  it("accepts patterns using real regular-expression syntax", () => {
    // These would all be rejected by a validator that had quietly become a
    // literal-string check — the failure mode a "does it compile" test
    // written only against plain words would not notice.
    expect(accepts(["^(ls|pwd)( .*)?$"])).toBe(true);
    expect(accepts(["\\bnpm run [a-z:]+\\b"])).toBe(true);
    expect(accepts(["rm\\s+-rf\\s+/"])).toBe(true);
  });

  it("accepts several patterns in one list, and duplicates", () => {
    // Order is not load-bearing and a duplicate is harmless — the schema
    // deliberately does not treat either as a validation failure.
    expect(accepts(["^ls$", "^pwd$", "^ls$"])).toBe(true);
  });
});

describe("hook pattern lists — what they refuse", () => {
  it("refuses a pattern that cannot compile as a regular expression", () => {
    // The guarantee the validation exists for. Unbalanced brackets and a
    // dangling quantifier are the two shapes a person actually types.
    expect(accepts(["["])).toBe(false);
    expect(accepts(["(unclosed"])).toBe(false);
    expect(accepts(["a{2,1}"])).toBe(false);
    expect(accepts(["*"])).toBe(false);
  });

  it("names the offending pattern in the message, not just the index", () => {
    // A settings write is a person's edit; "invalid" without saying which
    // entry sends them reading the whole list.
    const result = hookPatternListSchema.safeParse(["^ok$", "("]);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    expect(JSON.stringify(result.error.issues)).toContain("not a valid regular expression");
    expect(JSON.stringify(result.error.issues)).toContain("(");
  });

  it("refuses one bad pattern even when every other entry is fine", () => {
    // The case that matters in practice: a working list edited to add one
    // broken entry. A validator checking only the first element passes this.
    expect(accepts(["^ls$", "^pwd$", "["])).toBe(false);
  });

  it("refuses an empty string, which compiles but matches everything", () => {
    // `new RegExp("")` is perfectly valid and matches every command, so a
    // check that only asked "does it compile" would let it through — and an
    // empty entry in the ALLOW list silently exempts every tool call from
    // the ask-list. The `.min(1)` is doing real work, not tidiness.
    expect(accepts([""])).toBe(false);
  });

  it("refuses a non-string entry and a non-array value", () => {
    expect(accepts([42])).toBe(false);
    expect(accepts([null])).toBe(false);
    expect(accepts("^ls$")).toBe(false);
    expect(accepts(null)).toBe(false);
  });
});

describe("the validation is reachable through the settings write path", () => {
  // The schema being correct is worth little if the write path does not
  // consult it. These go through `validateSetting`, which is what
  // `put_setting` and `patch_settings` call.
  it("rejects an invalid pattern written to hook.allow_patterns", () => {
    const result = validateSetting("hook.allow_patterns", ["("]);
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid pattern written to hook.ask_patterns", () => {
    // Both keys share one schema, and asserting only one of them would not
    // notice a registry entry wired to the wrong validator.
    const result = validateSetting("hook.ask_patterns", ["("]);
    expect(result.ok).toBe(false);
  });

  it("accepts a valid pattern on both keys", () => {
    expect(validateSetting("hook.allow_patterns", ["^git status$"]).ok).toBe(true);
    expect(validateSetting("hook.ask_patterns", ["^git push .*$"]).ok).toBe(true);
  });
});
