// Chip → board links — M10 T10. Asserts the parameter names LITERALLY, the
// same way `tests/board-filters-url.test.ts` (on `feat/board-filter-sort-search`,
// not yet on `main` — see `board-link.ts`'s own header) pins them: a round
// trip alone would still pass after a rename broke every link this file's
// own module builds.
import { describe, expect, it } from "vitest";
import { boardLinkFor, BOARD_LINK_PARAMS } from "@/lib/item-detail/board-link";

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
