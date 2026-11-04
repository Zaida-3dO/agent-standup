// The people-first title rules: dates, ids, quotes, "who and when" tags, links,
// codenames, branch names, versions, a long title and a separator.
//
// Two halves pull in opposite directions and both are load-bearing. The
// firing cases prove each shape is caught; the silence cases prove ordinary
// prose is not. A file with only the first half would pass against a check
// that returns a finding for every string, which no caller would tolerate —
// so the silence list is the longer one, and several entries are chosen
// because a lazier pattern would trip on them (`up-to-date`, `3 a.m.`,
// `0.5 seconds`, an apostrophe, a lowercase `wave`).
//
// WHAT A GREEN RUN MEANS. Silence means none of these shapes matched, not
// that the title is good: "Key insights follow what really happened" matches
// nothing here and still says nothing at a glance. The rules catch recurring
// shapes; judgement about meaning stays with the author. The examples below
// are invented, in the shape of titles that really appeared.
//
// Pure module, no database: this file never skips.
import { describe, expect, it } from "vitest";
import { findTitleFindings } from "@/lib/item-title";
import {
  findPlainTextFindings,
  hasTitleSeparator,
  TITLE_ADVISE_MAX_CHARS,
  TITLE_ADVISE_MAX_WORDS,
} from "@/lib/plain-text-rules";

function rulesFor(title: string): string[] {
  return findTitleFindings(title).map((finding) => finding.rule);
}

describe("title rules: shapes that must be caught", () => {
  // The project-name shape: a short name, a dash, then the explanation.
  it("flags a name followed by a dash and a long explanation", () => {
    const rules = rulesFor(
      "Home Hub - furnish the house: windows, curtains, furniture, footstep zones, grouped specs",
    );
    expect(rules).toContain("title_separator");
    expect(rules).toContain("title_long");
  });

  it("flags a spaced en dash and an (already normalised) em dash as separators", () => {
    expect(rulesFor("Fix the checkout – and the basket")).toContain("title_separator");
    expect(rulesFor("Fix the checkout — and the basket")).toContain("title_separator");
  });

  it("flags a semicolon", () => {
    expect(rulesFor("Add themes; then sounds")).toContain("title_separator");
  });

  it("flags a colon after a multi-word prefix", () => {
    expect(rulesFor("Single branch fixes: themes and sounds")).toContain("title_separator");
  });

  it("flags a second colon even after a one-word label", () => {
    expect(rulesFor("Helm: fixes: themes")).toContain("title_separator");
  });

  describe("dates", () => {
    const DATED = [
      "Fix the cart total on 2026-10-29",
      "Fix the cart total 3 Nov",
      "Fix the cart total on 3rd November",
      "Fix the cart total from Nov 3",
      "Fix the cart total reported 29/10/2026",
    ];
    for (const title of DATED) {
      it(`flags ${JSON.stringify(title)}`, () => {
        expect(rulesFor(title).some((rule) => rule === "date" || rule === "author_date")).toBe(
          true,
        );
      });
    }
  });

  it("flags a leading request number and date, the shape a progress script writes", () => {
    const rules = rulesFor("3 Nov #24 - Production time counts the cards in a pack");
    expect(rules).toContain("date");
    expect(rules).toContain("cross_reference");
    expect(rules).toContain("title_separator");
  });

  it("flags a leading 'Name date:' prefix and says it is an author tag", () => {
    const findings = findTitleFindings(
      'Dana 2026-10-17: "yes start it and ship it please" - deep link',
    );
    const rules = findings.map((finding) => finding.rule);
    expect(rules).toContain("author_date");
    expect(rules).toContain("quoted_text");
    expect(rules).toContain("title_separator");
    // Said in words a person understands, not as a rule id.
    expect(findings.find((f) => f.rule === "author_date")?.message).toContain("name and a date");
  });

  it("flags a bracketed author-and-date tag", () => {
    expect(rulesFor("Furnish the house (Dana 2026-10-29)")).toContain("author_date");
  });

  describe("ids", () => {
    it("flags a full uuid", () => {
      expect(rulesFor("Fix 767322fe-1b2c-4d3e-8f90-123456789abc")).toContain("id");
    });
    it("flags a short hex id", () => {
      expect(rulesFor("Look at item 767322fe again")).toContain("id");
    });
    it("flags #123 through the existing reference rule", () => {
      expect(rulesFor("Fix #123 before the release")).toContain("cross_reference");
    });
  });

  describe("quoted text", () => {
    it("flags a double-quoted sentence", () => {
      expect(rulesFor('Handle "yes start it please" requests')).toContain("quoted_text");
    });
    it("flags curly quotes", () => {
      expect(rulesFor("Handle “yes start it please” requests")).toContain("quoted_text");
    });
    it("flags a single-quoted sentence that opens after a space", () => {
      expect(rulesFor("Handle 'start it now' requests")).toContain("quoted_text");
    });
  });

  describe("links and schemes", () => {
    it("flags a web address", () => {
      expect(rulesFor("Mirror https://example.com/docs for offline use")).toContain("url");
    });
    it("flags an app link scheme", () => {
      expect(rulesFor("Open the viewer with app://open links")).toContain("url");
    });
    it("flags a bare www address", () => {
      expect(rulesFor("Move the docs to www.example.com now")).toContain("url");
    });
  });

  describe("codenames", () => {
    it("flags a wave id", () => {
      expect(rulesFor("Finish the w12 fixes")).toContain("codename");
    });
    it("flags a lettered and a numbered wave", () => {
      expect(rulesFor("Ship Wave A fixes")).toContain("codename");
      expect(rulesFor("Ship wave 2 fixes")).toContain("codename");
    });
    it("flags a crew name", () => {
      expect(rulesFor("Hand over to crew-w12 now")).toContain("codename");
    });
  });

  describe("branch names", () => {
    it("flags a label-segment branch", () => {
      expect(rulesFor("Merge w12-health-delight into the release")).toContain("branch_name");
    });
    it("flags a prefixed branch", () => {
      expect(rulesFor("Merge fix-login-redirect when green")).toContain("branch_name");
    });
    it("flags a slash branch", () => {
      expect(rulesFor("Review feat/login-redirect first")).toContain("branch_name");
    });
  });

  describe("version numbers", () => {
    it("flags a v-prefixed version", () => {
      expect(rulesFor("Ship v1.2 of the app")).toContain("version");
    });
    it("flags a three-part version", () => {
      expect(rulesFor("Bump the app to 0.6.3")).toContain("version");
    });
    it("flags a two-part version after a version word", () => {
      expect(rulesFor("Upgrade to version 2.1 this week")).toContain("version");
    });
  });

  describe("length", () => {
    it("flags a title over the character limit", () => {
      const title =
        `Let people reset a forgotten password ${"and then reset it again ".repeat(3)}`.trim();
      expect(title.length).toBeGreaterThan(TITLE_ADVISE_MAX_CHARS);
      expect(rulesFor(title)).toContain("title_long");
    });

    it("flags a title over the word limit even when it is short in characters", () => {
      const title = Array.from({ length: TITLE_ADVISE_MAX_WORDS + 1 }, () => "go").join(" ");
      expect(title.length).toBeLessThan(TITLE_ADVISE_MAX_CHARS);
      expect(rulesFor(title)).toContain("title_long");
    });

    it("names the title and tells the author to attach a document", () => {
      const finding = findTitleFindings(`${"word ".repeat(30)}end`).find(
        (f) => f.rule === "title_long",
      );
      expect(finding?.field).toBe("title");
      expect(finding?.message).toContain("title");
      expect(finding?.message).toContain("document");
    });
  });
});

describe("title rules: ordinary prose must stay silent", () => {
  // Every entry is a title a person would write. A finding on any of them
  // trains callers to ignore the advice, which costs more than the feature.
  const PLAIN = [
    "Open the viewer on the TVs from the home dashboard",
    "Production time counts the cards in a pack",
    "Let people reset a forgotten password",
    "Move the admin page to its own address",
    // The plan's own better-title shape: a one-word label and one colon on a short title.
    "Helm: fixes, themes, sounds and saved for later",
    "Fix: the crash on save",
    // Hyphenated English is not a branch name.
    "Make the install up-to-date",
    "Support end-to-end encryption",
    "Build a state-of-the-art search page",
    "Write a 3-step-process guide",
    "Fix Wi-Fi sign-in on the tablet",
    "Stop double-charging annual subscribers",
    // Numbers and times that are not dates or versions.
    "Stop sending email at 3 a.m. to new users",
    "Show 2 decimals on the price",
    "Wait 0.5 seconds before retrying",
    "Charge 4.99 for delivery",
    "Support Postgres 16",
    "Freeze the 2026 pricing tier",
    "Send the digest at 10:30",
    "Plan the March release",
    // Apostrophes are not quotes; one quoted word is a name.
    "Stop users' sessions expiring too early",
    "Don't lose the draft when the tab closes",
    'Rename the "Inbox" label',
    // The word wave on its own is just a word.
    "Add a wave animation to the loader",
    "Ride the wave of new signups",
    // Words that merely look like hex.
    "Effaced labels reappear on the card",
    "Show the deadline in the header",
  ];
  for (const title of PLAIN) {
    it(`stays silent on ${JSON.stringify(title)}`, () => {
      expect(findTitleFindings(title)).toEqual([]);
    });
  }

  it("does not fire on a colon inside a time or a link scheme position", () => {
    expect(hasTitleSeparator("Send the digest at 10:30")).toBe(false);
    expect(hasTitleSeparator("Use the app://open link")).toBe(false);
  });

  it("keeps the one-word-label exemption narrow: it needs a short title", () => {
    // Nine words after a one-word label is a sentence, not a label.
    expect(hasTitleSeparator("Helm: fixes themes sounds and a saved list for later use")).toBe(
      true,
    );
  });

  it("never throws or blocks: every rule is advice", () => {
    expect(() => findPlainTextFindings("", "title")).not.toThrow();
    expect(findPlainTextFindings("", "title")).toEqual([]);
  });
});

describe("plain-text rules are bounded", () => {
  it("scans a pathological title quickly", () => {
    // A long run of quote characters and spaces would be the shape that
    // stalls a backtracking quote matcher; the scan window caps the work.
    const pathological = `"a `.repeat(100_000);
    const started = performance.now();
    findTitleFindings(pathological);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("a non-title field gets the plain rules without the title-only ones", () => {
  it("does not apply the length or separator rule to a headline", () => {
    const rules = findPlainTextFindings(
      "Furnishing the house: windows, curtains; and furniture - all of it, in plain words for everyone to read",
      "headline",
    ).map((finding) => finding.rule);
    expect(rules).not.toContain("title_long");
    expect(rules).not.toContain("title_separator");
  });

  it("names the field in the message", () => {
    const [finding] = findPlainTextFindings("Done on 2026-10-29", "headline");
    expect(finding?.field).toBe("headline");
    expect(finding?.message).toContain("headline");
  });
});
