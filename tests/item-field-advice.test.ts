// Advice on the fields a person reads besides the title: the headline, the
// body, and a subtask that reads like an implementation step.
//
// Same two-sided shape as `item-title.test.ts`: the firing cases prove each
// nudge is real, and the silence cases prove a plain headline, a normal body
// and a result-shaped subtask are left alone. The silence half is the larger
// one on purpose — a nudge that fires on ordinary writing gets ignored.
//
// A quiet result means none of these shapes matched, not that the text is
// good. Every example is invented.
//
// Pure module, no database: this file never skips.
import { describe, expect, it } from "vitest";
import {
  BODY_ADVISE_MAX_CHARS,
  FIELD_CONVENTION_RULE,
  fieldAdviceFor,
  findFieldFindings,
  HEADLINE_ADVISE_MAX_CHARS,
  headlineRepeatsTitle,
  looksLikeImplementationStep,
} from "@/lib/item-field-advice";

function rulesFor(input: Parameters<typeof findFieldFindings>[0]): string[] {
  return findFieldFindings(input).map((finding) => finding.rule);
}

describe("a headline that repeats the title", () => {
  it("flags an exact copy", () => {
    expect(
      rulesFor({
        repeatCheck: {
          title: "Production time counts the cards in a pack",
          headline: "Production time counts the cards in a pack",
        },
      }),
    ).toContain("headline_repeats_title");
  });

  it("flags a copy that differs only in case and punctuation", () => {
    expect(headlineRepeatsTitle("Reset a forgotten password", "reset a forgotten password.")).toBe(
      true,
    );
  });

  it("flags a copy with a date and request-number prefix, the shape a progress script writes", () => {
    expect(
      headlineRepeatsTitle(
        "Production time counts the cards in a pack",
        "3 Nov #24 - Production time counts the cards in a pack",
      ),
    ).toBe(true);
  });

  it("does not flag a headline that adds something the title does not say", () => {
    expect(
      headlineRepeatsTitle(
        "Production time counts the cards in a pack",
        "A pack counts as its singles, and the delivery dates on the product page and basket use it.",
      ),
    ).toBe(false);
  });

  it("does not flag a short title that merely appears inside a long, informative headline", () => {
    // The 0.7 length ratio is what separates a copy from a headline that
    // happens to contain the title's words.
    expect(
      headlineRepeatsTitle(
        "Password reset",
        "Password reset links now last a day instead of ten minutes, so people on slow mail still get in.",
      ),
    ).toBe(false);
  });

  it("is quiet when there is no headline to compare", () => {
    expect(
      rulesFor({ repeatCheck: { title: "Reset a forgotten password", headline: null } }),
    ).toEqual([]);
  });

  it("is quiet for two empty-after-normalising strings", () => {
    expect(headlineRepeatsTitle("???", "!!!")).toBe(false);
  });
});

describe("a headline that carries what the board should not show", () => {
  it("flags a date, naming the headline", () => {
    const findings = findFieldFindings({ headline: "Done on 2026-10-29 after review." });
    expect(findings.map((f) => f.rule)).toContain("date");
    expect(findings.every((f) => f.field === "headline")).toBe(true);
  });

  it("flags a quoted approval, a link and a codename", () => {
    const rules = rulesFor({
      headline: 'Dana said "yes start it please", see https://example.com for wave 2.',
    });
    expect(rules).toContain("quoted_text");
    expect(rules).toContain("url");
    expect(rules).toContain("codename");
  });

  it("flags a code identifier and a bare reference, with wording that names the headline", () => {
    const findings = findFieldFindings({ headline: "Route writes through appendEvent for #102." });
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain("code_identifier");
    expect(rules).toContain("cross_reference");
    expect(findings.find((f) => f.rule === "cross_reference")?.message).toContain("headline");
  });

  it("flags a headline over the sentence limit and says to attach a document", () => {
    const headline = "x".repeat(HEADLINE_ADVISE_MAX_CHARS + 1);
    const finding = findFieldFindings({ headline }).find((f) => f.rule === "headline_long");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("document");
  });

  it("does not hold a headline to the title-only rules (a comma list, a dash, a colon)", () => {
    const rules = rulesFor({
      headline: "Furnishing the house: windows, curtains and furniture - all in plain words.",
    });
    expect(rules).not.toContain("title_separator");
    expect(rules).not.toContain("title_long");
    expect(rules).not.toContain("too_short");
  });
});

describe("plain headlines stay silent", () => {
  const PLAIN = [
    "Furnishing the house: windows, curtains and furniture.",
    "Let Home Assistant open the viewer app on the TVs with a link.",
    "Production time counts a pack as its singles, and the delivery dates on the product page and basket use it.",
    "Fixed the reported problems and added themes, sounds and a saved-for-later list.",
    "Waiting on the supplier to confirm the new price list.",
    "People can now reset a password without asking for help.",
    "Stop double-charging annual subscribers.",
  ];
  for (const headline of PLAIN) {
    it(`says nothing about ${JSON.stringify(headline)}`, () => {
      expect(findFieldFindings({ headline })).toEqual([]);
    });
  }

  it("stays under the sentence limit by a margin, so the limit is not the only thing keeping these quiet", () => {
    for (const headline of PLAIN)
      expect(headline.length).toBeLessThanOrEqual(HEADLINE_ADVISE_MAX_CHARS);
  });
});

describe("the body size nudge", () => {
  it("fires over the limit, names the body and says to attach a document", () => {
    const finding = findFieldFindings({ body: "b".repeat(BODY_ADVISE_MAX_CHARS + 1) }).find(
      (f) => f.rule === "body_long",
    );
    expect(finding?.field).toBe("body");
    expect(finding?.message).toContain("document");
  });

  it("is quiet exactly at the limit (the boundary is inclusive)", () => {
    expect(rulesFor({ body: "b".repeat(BODY_ADVISE_MAX_CHARS) })).toEqual([]);
  });

  it("is quiet for an ordinary body and for no body", () => {
    expect(rulesFor({ body: "The reset link expires too fast. See the mailer config." })).toEqual(
      [],
    );
    expect(rulesFor({})).toEqual([]);
    expect(rulesFor({ body: null })).toEqual([]);
  });
});

describe("a subtask that reads like an implementation step", () => {
  const STEPS = [
    "Split the container ports and the reverse proxy",
    "Refactor the mailer",
    "Wire the button to the handler",
    "Bump the base image",
    "Add unit tests for the mailer",
    "Update the env var for the staging site",
    "Write the migration for the new column",
  ];
  for (const title of STEPS) {
    it(`flags ${JSON.stringify(title)}`, () => {
      expect(looksLikeImplementationStep(title)).toBe(true);
      expect(rulesFor({ subtaskTitle: title })).toContain("step_like_subtask");
    });
  }

  const RESULTS = [
    "Send the reset email",
    "Let people reset a forgotten password",
    "Move the admin page to its own address",
    "Show the delivery date on the basket",
    "Make the print proof available to the studio",
    "Add a rate limit to the sign-in page",
    "Fix the crash when saving a draft",
  ];
  for (const title of RESULTS) {
    it(`leaves the result-shaped ${JSON.stringify(title)} alone`, () => {
      expect(looksLikeImplementationStep(title)).toBe(false);
      expect(rulesFor({ subtaskTitle: title })).toEqual([]);
    });
  }

  it("points at loops on the parent task", () => {
    const finding = findFieldFindings({ subtaskTitle: "Refactor the mailer" }).find(
      (f) => f.rule === "step_like_subtask",
    );
    expect(finding?.message).toContain("loops");
    expect(finding?.message).toContain("parent task");
  });

  it("only checks a subtask when asked: a task or project title is never examined for this", () => {
    expect(rulesFor({ headline: "Fine." })).not.toContain("step_like_subtask");
  });
});

describe("fieldAdviceFor", () => {
  it("returns null when there is nothing to say, so a response carries no key", () => {
    expect(
      fieldAdviceFor({
        headline: "People can now reset a password without asking for help.",
        body: "Short.",
        repeatCheck: { title: "Reset a forgotten password", headline: null },
      }),
    ).toBeNull();
  });

  it("folds every finding into one note", () => {
    const advice =
      fieldAdviceFor({
        headline: "Done on 2026-10-29.",
        body: "b".repeat(BODY_ADVISE_MAX_CHARS + 1),
      }) ?? "";
    expect(advice.startsWith("A note on the fields:")).toBe(true);
    expect(advice).toContain("date");
    expect(advice).toContain("body");
  });

  it("states the convention callers read, including that nothing is refused", () => {
    expect(FIELD_CONVENTION_RULE).toContain("document");
    expect(FIELD_CONVENTION_RULE).toContain("loops");
    expect(FIELD_CONVENTION_RULE).toMatch(/None of this is refused/);
    // The numbers in the prose are the numbers the check uses.
    expect(FIELD_CONVENTION_RULE).toContain(String(HEADLINE_ADVISE_MAX_CHARS));
    expect(FIELD_CONVENTION_RULE).toContain(String(BODY_ADVISE_MAX_CHARS));
  });
});
