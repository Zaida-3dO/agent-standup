// The item-title convention — MILESTONES.md #131.
//
// Two things are being pinned here, and they pull in opposite directions:
// the check has to *fire* on the shapes that made the board unreadable, and
// it has to *stay silent* on ordinary prose. A one-sided suite is the failure
// mode worth naming up front — a file that only proves the firing cases would
// pass just as happily against a check that returns a finding for every
// string, which is the version of this feature nobody would tolerate.
//
// So the silence cases below are load-bearing, not padding, and several are
// chosen specifically because a lazier pattern would trip on them: a title
// with a capitalised proper noun, one with a hyphen, one naming a language
// whose name contains punctuation. Each names the widening that would break
// it, in the house style — a test that cannot fail is visible as such.
//
// Pure module, no database: this file never skips.
import { describe, expect, it } from "vitest";
import {
  findTitleFindings,
  titleAdviceFor,
  TITLE_CONVENTION_RULE,
  TITLE_MIN_WORDS,
} from "@/lib/item-title";

/** The rule ids a title tripped, which is what a caller matches on. */
function rulesFor(title: string): string[] {
  return findTitleFindings(title).map((finding) => finding.rule);
}

describe("findTitleFindings — the shapes that make a board unreadable", () => {
  // The row's own quoted example, kept verbatim. If this stops firing, the
  // feature no longer addresses the case it was filed for.
  it("fires on the imported work-order shape the row quotes", () => {
    const rules = rulesFor(
      "agent-standup #102 - route the four raw event writes through appendEvent",
    );
    expect(rules).toContain("cross_reference");
    expect(rules).toContain("code_identifier");
  });

  // Fails if CROSS_REFERENCE loses its `#\d+` alternative.
  it("fires on a bare issue number", () => {
    expect(rulesFor("Fix #14 before the release")).toContain("cross_reference");
  });

  // Fails if the `PR-\d+` alternative is dropped.
  it("fires on a PR reference", () => {
    expect(rulesFor("PR-14 follow-up work")).toContain("cross_reference");
  });

  // Fails if the `§` alternative is dropped.
  it("fires on a section reference", () => {
    expect(rulesFor("Implement §6a of the spec")).toContain("cross_reference");
  });

  // Fails if CODE_IDENTIFIER loses its camelCase alternative.
  it("fires on a camelCase identifier", () => {
    expect(rulesFor("update normalizeEmDash to cover more cases")).toContain("code_identifier");
  });

  // Fails if the snake_case alternative is dropped.
  it("fires on a snake_case identifier", () => {
    expect(rulesFor("validate the blocked_reason field")).toContain("code_identifier");
  });

  // Fails if the dotted-path alternative is dropped.
  it("fires on a dotted path", () => {
    expect(rulesFor("read items.max_depth on every create")).toContain("code_identifier");
  });

  // Fails if the `\w+\(\)` alternative is dropped.
  it("fires on a function call", () => {
    expect(rulesFor("call toItemRecord() for every row")).toContain("code_identifier");
  });

  // Fails if FILE_PATH loses its slash-path alternative.
  it("fires on a file path", () => {
    expect(rulesFor("Fix the bug in src/lib/service/registry")).toContain("file_path");
  });

  // Fails if the extension alternative is dropped.
  it("fires on a bare filename with a known extension", () => {
    expect(rulesFor("Rewrite the seed in schema.prisma")).toContain("file_path");
  });

  // Fails if the word-count floor is removed or lowered to 1. A single word
  // cannot carry a subject and a verb, which is the whole claim of a title.
  it("fires on a one-word title", () => {
    expect(rulesFor("Inbox")).toContain("too_short");
  });

  // Punctuation is not a word. Fails if the counter stops filtering for
  // letters and digits and just counts whitespace-separated tokens.
  it("counts words by letters and digits, so punctuation alone is not a word", () => {
    expect(rulesFor("Inbox —")).toContain("too_short");
  });

  it("reports every finding at once rather than stopping at the first", () => {
    // A caller fixing one problem should not have to resubmit to discover
    // the next. Fails if the function returns early on its first hit.
    const rules = rulesFor("fix appendEvent in src/lib/events for #102");
    expect(new Set(rules).size).toBeGreaterThan(1);
  });

  it("names the offending field on every finding", () => {
    for (const finding of findTitleFindings("fix appendEvent for #102")) {
      expect(finding.field).toBe("title");
    }
  });

  it("takes the field name from the caller, for a surface that spells it differently", () => {
    const [finding] = findTitleFindings("#102", "name");
    expect(finding?.field).toBe("name");
  });
});

describe("findTitleFindings — the prose it must leave alone", () => {
  // Every one of these is a title a person would reasonably write. A finding
  // on any of them is a false positive that would train callers to ignore
  // the advice entirely, which costs more than the feature is worth.
  const CLEAN = [
    "Add a rate limit to the public endpoint",
    "Let people reset a forgotten password",
    "Building the app foundation",
    "The board should load in under a second",
    "Sign-in fails for users with a plus in their email",
    "Support Postgres 16",
    "Make the C# exporter handle empty rows",
    "Ship the progress report",
    "Stop double-charging annual subscribers",
    "Titles are for people, not for machines",
  ];

  for (const title of CLEAN) {
    it(`stays silent on ${JSON.stringify(title)}`, () => {
      expect(findTitleFindings(title)).toEqual([]);
    });
  }

  // A hyphenated word is not a snake_case identifier, and a capitalised
  // proper noun is not camelCase. Fails if either pattern is widened to
  // "contains punctuation" or "contains a capital".
  it("does not mistake ordinary capitalisation or hyphenation for code", () => {
    expect(findTitleFindings("Stop double-charging Stripe customers")).toEqual([]);
  });

  // Fails if FILE_PATH's extension list becomes "any dot-suffixed word" —
  // an ordinary sentence ending in a short word would then match.
  it("does not treat a sentence's own punctuation as a filename", () => {
    expect(findTitleFindings("Users cannot log in. Fix it")).toEqual([]);
  });

  // A date is not a section reference, and a version is not a code path.
  it("does not fire on dates or version numbers", () => {
    expect(findTitleFindings("Freeze the 2026 pricing tier")).toEqual([]);
    expect(findTitleFindings("Upgrade to version 16 of the database")).toEqual([]);
  });
});

describe("titleAdviceFor", () => {
  it("returns null when there is nothing to say", () => {
    // Null rather than an empty string, so a caller tests presence. Fails if
    // the function is changed to always return a sentence.
    expect(titleAdviceFor("Add a rate limit to the public endpoint")).toBeNull();
  });

  it("returns one sentence carrying the finding's guidance", () => {
    const advice = titleAdviceFor("agent-standup #102 - route writes through appendEvent");
    expect(advice).not.toBeNull();
    expect(advice).toContain("body");
  });

  it("folds several findings into the one note", () => {
    // Fails if only the first finding's message survives — a caller would
    // fix one thing and be told about the next only on the next create.
    const advice = titleAdviceFor("fix appendEvent in src/lib/events for #102") ?? "";
    expect(advice).toContain("issue, PR or section number");
    expect(advice).toContain("identifier");
  });
});

describe("the convention as callers read it", () => {
  it("states where the technical detail goes, which is the whole rule", () => {
    // The rule text is what `describe_tool` serves and what the contract on
    // all four creates carries. Asserted on substance rather than exact
    // wording, so it can be reworded but not hollowed out.
    expect(TITLE_CONVENTION_RULE).toContain("body");
    expect(TITLE_CONVENTION_RULE).toContain("title");
  });

  it("says outright that a title is never refused for this", () => {
    // The advisory posture is the load-bearing design decision (see
    // `item-title.ts`). A caller must be able to read that it will not be
    // blocked, or it will write to the check rather than to the reader.
    expect(TITLE_CONVENTION_RULE).toMatch(/never refused|not refused/);
  });

  it("keeps the word floor and the message that cites it in step", () => {
    // Fails if TITLE_MIN_WORDS is changed without the message following —
    // the drift `complete_item`'s contract interpolates its caps to avoid.
    const [finding] = findTitleFindings("Inbox");
    expect(finding?.message).toContain(String(TITLE_MIN_WORDS));
  });
});
