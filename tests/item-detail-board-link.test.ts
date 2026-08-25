// Chip → board links — M10 T10. Asserts the parameter names LITERALLY, the
// same way `tests/board-filters-url.test.ts` pins them: a round trip alone
// would still pass after a rename broke every link this module builds.
//
// `board-link.ts` is now an adapter over `@/lib/board/filters` rather than
// its own encoder (the branch it was waiting on has merged), so these
// literals are doing a second job: they pin the board's OWN vocabulary from
// the chip side. Deriving the expectation from `BOARD_FILTER_PARAMS` would
// make this file agree with any rename, including one that breaks links.
import { describe, expect, it } from "vitest";
import { boardLinkFor, BOARD_LINK_PARAMS } from "@/lib/item-detail/board-link";
import { boardHref, emptyBoardQuery } from "@/lib/board/filters";

describe("BOARD_LINK_PARAMS", () => {
  it("is exactly the eight axes, spelled the way the board's filter bar spells them", () => {
    expect([...BOARD_LINK_PARAMS]).toEqual([
      "area",
      "repo",
      "assignee",
      "actor",
      "priority",
      "state",
      "kind",
      "search",
    ]);
  });
});

describe("boardLinkFor", () => {
  it("builds /board?<param>=<value> for a non-empty value", () => {
    expect(boardLinkFor("area", "web")).toBe("/board?area=web");
    expect(boardLinkFor("repo", "agent-standup")).toBe("/board?repo=agent-standup");
    expect(boardLinkFor("assignee", "gary")).toBe("/board?assignee=gary");
    expect(boardLinkFor("priority", "P0")).toBe("/board?priority=P0");
    expect(boardLinkFor("state", "blocked")).toBe("/board?state=blocked");
  });

  it("URL-encodes a value that needs it", () => {
    expect(boardLinkFor("area", "my area")).toBe("/board?area=my+area");
  });

  it("degrades to the plain board for an empty or whitespace-only value", () => {
    // A chip with nothing to say about (an item with no repo) must not
    // link to a query string the board would refuse or silently ignore —
    // the exact "broken link is worse than no link" case the task's own
    // merge policy calls out.
    expect(boardLinkFor("repo", "")).toBe("/board");
    expect(boardLinkFor("repo", "   ")).toBe("/board");
  });

  it("trims a value with surrounding whitespace", () => {
    expect(boardLinkFor("area", "  web  ")).toBe("/board?area=web");
  });
});

describe("board-link agrees with the board's own encoder", () => {
  // **Honest note on what this pair can and cannot catch.** Substituting a
  // hand-built `URLSearchParams` encoder for the delegation to `boardHref`
  // passes every test in this file, including the one below — established
  // by mutation rather than assumed. A standalone encoder and the board's
  // own agree on every single-filter input, which is both why delegating is
  // safe and why no black-box test can observe that it happens.
  //
  // So this is a DRIFT DETECTOR, not a proof of the delegation: it fails
  // the moment `boardHref` emits something a standalone encoder would not
  // (a newly always-emitted parameter, a changed default level, a different
  // encoding of spaces). A chip that built its own address would ship a
  // silently broken link on that day; delegating makes it impossible, and
  // these tests fail loudly for anyone who stops delegating. The structural
  // guarantee is carried by the single import — that is the point.
  it("emits byte-identical strings to boardHref for the same narrowing", () => {
    for (const param of BOARD_LINK_PARAMS) {
      const base = emptyBoardQuery();
      const expected = boardHref({
        ...base,
        filters: { ...base.filters, [param]: "web" },
      });
      expect(boardLinkFor(param, "web")).toBe(expected);
    }
  });

  it("carries no level parameter, so a chip link is the board's short address", () => {
    // `emptyBoardQuery`'s default level emits nothing. If this module ever
    // set an explicit non-default level, every chip would produce a second
    // spelling of one board — the exact defect the determinism rule in
    // `boardQueryString` exists to prevent.
    expect(boardLinkFor("area", "web")).not.toContain("level");
  });
});
