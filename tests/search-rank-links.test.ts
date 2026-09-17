// How a link match is ranked — the pure half of acceptance criterion 3.
//
// The database half (that `search` actually returns an item found only by
// its link) is in `tests/item-links.test.ts`. This file asserts the
// opinion: where a link sits relative to the other fields, and that several
// links on one item are scored as repeated instances of one field rather
// than as independent evidence.
import { describe, expect, it } from "vitest";
import { MATCH_FIELDS, rankMatch } from "@/lib/service/items/search-rank";

const base = { title: "Title", headline: null, body: "Body" } as const;

describe("MATCH_FIELDS", () => {
  it("includes link, so a link is a place search looks", () => {
    expect(MATCH_FIELDS).toContain("link");
  });
});

describe("rankMatch — a link is reachable at all", () => {
  // The whole point. Would pass wrongly if `scoreLinks` were never called
  // from the loop: the row would rank null and `search` would DROP it, which
  // looks exactly like search not working.
  it("matches a url that appears nowhere else on the item", () => {
    const ranked = rankMatch(
      { ...base, links: [{ key: "slack", url: "https://chat.example.test/t/99" }] },
      "chat.example.test",
    );
    expect(ranked).not.toBeNull();
    expect(ranked!.matchedIn).toBe("link");
  });

  it("matches a key as well as a url", () => {
    const ranked = rankMatch({ ...base, links: [{ key: "slack", url: "coda://x" }] }, "slack");
    expect(ranked!.matchedIn).toBe("link");
  });

  it("returns null when the query is in neither the text nor the links", () => {
    expect(rankMatch({ ...base, links: [{ key: "slack", url: "coda://x" }] }, "absent")).toBeNull();
  });

  // `links` is optional on `SearchableFields` so existing callers keep
  // compiling; absent and empty must mean the same thing.
  it("treats absent and empty link lists alike", () => {
    expect(rankMatch({ ...base }, "Title")).toEqual(rankMatch({ ...base, links: [] }, "Title"));
  });
});

describe("rankMatch — where a link sits in the order", () => {
  // Would pass wrongly if the link weight were raised to or above
  // `headline`'s. A caller typing a word like "slack" matches every link key
  // in the corpus at once, which is a far weaker answer to "find the item
  // about X" than a headline written to say what the item is.
  //
  // **Compared like for like, which is the part that took a correction.**
  // An earlier version of this case pitted an EXACT link-key match against a
  // PARTIAL headline match and failed — correctly, and not because the
  // weights are wrong. `EXACT_BONUS` is 150 against field weights of 40 and
  // 35, so it deliberately dominates: a caller who typed the whole value
  // means that row, whichever field it sits in, and that is pre-existing
  // behaviour applied identically to every field. Holding the bonus constant
  // on both sides is what isolates the weight, which is the thing this case
  // is actually about.
  it("ranks below a headline match, bonuses held equal", () => {
    const viaHeadline = rankMatch({ ...base, headline: "slack thread triage" }, "slack")!;
    const viaLink = rankMatch(
      { ...base, links: [{ key: "slack thread triage", url: "coda://x" }] },
      "slack",
    )!;
    expect(viaHeadline.score).toBeGreaterThan(viaLink.score);
  });

  // Would pass wrongly if the link weight were dropped below `body`'s. An
  // item carrying a link to a ticket is, with near-certainty, the item for
  // that ticket; the same id in a paragraph of prose is often a passing
  // mention of neighbouring work.
  it("ranks above a body match", () => {
    const viaBody = rankMatch({ ...base, body: "mentions TICKET-1 in passing" }, "TICKET-1")!;
    const viaLink = rankMatch(
      { ...base, links: [{ key: "ticket", url: "https://example.test/TICKET-1" }] },
      "TICKET-1",
    )!;
    expect(viaLink.score).toBeGreaterThan(viaBody.score);
  });

  it("ranks below a title match", () => {
    const viaTitle = rankMatch({ ...base, title: "slack" }, "slack")!;
    const viaLink = rankMatch({ ...base, links: [{ key: "slack", url: "coda://x" }] }, "slack")!;
    expect(viaTitle.score).toBeGreaterThan(viaLink.score);
  });
});

describe("rankMatch — several links are one field, not several", () => {
  // **The load-bearing assertion of `scoreLinks`.** Would pass wrongly if
  // the per-link scores were summed instead of maxed: an item carrying five
  // loosely-matching pointers would then outrank an item whose single link
  // is exactly what was asked for — ranking by quantity of pointers rather
  // than quality of match.
  it("does not let many weak link matches outrank one strong one", () => {
    const many = rankMatch(
      {
        ...base,
        links: [
          { key: "a", url: "https://example.test/report/1" },
          { key: "b", url: "https://example.test/report/2" },
          { key: "c", url: "https://example.test/report/3" },
          { key: "d", url: "https://example.test/report/4" },
          { key: "e", url: "https://example.test/report/5" },
        ],
      },
      "report",
    )!;
    const one = rankMatch({ ...base, links: [{ key: "report", url: "coda://x" }] }, "report")!;
    expect(one.score).toBeGreaterThanOrEqual(many.score);
  });

  // Would pass wrongly if the link values were concatenated into one string
  // before scoring: the joined haystack can never equal a single query, so
  // the exact-match bonus would become unreachable the moment an item had a
  // second link — an item whose link is exactly the pasted URL would rank
  // LOWER for carrying an unrelated one.
  it("still awards the exact-match bonus when another link is present", () => {
    const url = "https://example.test/exact";
    const alone = rankMatch({ ...base, links: [{ key: "a", url }] }, url)!;
    const withNeighbour = rankMatch(
      {
        ...base,
        links: [
          { key: "a", url },
          { key: "b", url: "coda://unrelated" },
        ],
      },
      url,
    )!;
    expect(withNeighbour.score).toBe(alone.score);
  });

  // The counterpart: a match in the text AND in a link is genuinely more
  // evidence than a link alone, because those are different descriptions of
  // one item rather than repeated instances of one field.
  it("accumulates a link match with a text match", () => {
    const linkOnly = rankMatch({ ...base, links: [{ key: "slack", url: "coda://x" }] }, "slack")!;
    const both = rankMatch(
      { ...base, title: "slack", links: [{ key: "slack", url: "coda://x" }] },
      "slack",
    )!;
    expect(both.score).toBeGreaterThan(linkOnly.score);
  });
});
