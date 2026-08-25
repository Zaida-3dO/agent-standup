// The board's URL contract — MILESTONES.md #75.
//
// **This is the file that pins the contract other screens depend on.** A
// sibling row makes an item's detail chips link back to a pre-filtered
// board, and it does that by building one of these query strings. So the
// parameter *names* are asserted literally here rather than round-tripped
// through the codec: a round trip alone would still pass after someone
// renamed `area` to `areaId` on both sides, and every link built elsewhere
// would break silently.
//
// The single-character changes each assertion is protecting against are
// named in the comments, because a test whose failure mode nobody can state
// is a test that will be deleted the first time it is inconvenient.
import { describe, expect, it } from "vitest";
import {
  BOARD_FILTER_PARAMS,
  activeFilterCount,
  boardHref,
  boardQueryString,
  boardRequestParams,
  emptyBoardQuery,
  isFiltered,
  parseBoardQuery,
  withFilter,
  withoutFilters,
  type BoardQuery,
} from "@/lib/board/filters";

describe("the board's query parameter names", () => {
  it("are exactly the ten the API accepts, spelled the way the API spells them", () => {
    // Literal, not derived. Deriving this list from the same constant the
    // code uses would make the assertion vacuous — it would pass however the
    // names were spelled. Changing one character of one name below is the
    // change that breaks every detail-page chip link, and this is what
    // catches it.
    //
    // The ORDER is asserted too, not just the membership, because the order
    // of this list is what `boardQueryString` emits parameters in — so one
    // board having one address depends on it.
    expect([...BOARD_FILTER_PARAMS]).toEqual([
      "area",
      "repo",
      "assignee",
      "actor",
      "priority",
      "state",
      "kind",
      "level",
      "project",
      "trust",
      "search",
    ]);
  });

  it("reaches every filter the board operation accepts", () => {
    // The acceptance criterion in one assertion: the operation's filter
    // inputs, minus the paging ones a reader does not set. A filter added to
    // `get_board` and forgotten here is a filter the board cannot reach,
    // which is the exact defect this row exists to fix.
    const serviceFilters = [
      "area",
      "repo",
      "assignee",
      "actor",
      "priority",
      "state",
      "kind",
      // Depth-based, and NOT reachable through `kind`: `kind` collapses
      // every level from 2 down into `subtask`, so a board that offered only
      // `kind` could not express "level 2 but not level 4".
      "level",
      // One project's whole subtree.
      "project",
      // Whether a row's state can be taken on faith. Marked on every card
      // since the trust badge landed; listed here because a marking nobody
      // can filter by is a capability the board cannot actually reach.
      "trust",
      "search",
    ];
    for (const filter of serviceFilters) {
      expect(BOARD_FILTER_PARAMS).toContain(filter);
    }
  });
});

describe("parseBoardQuery", () => {
  it("reads every axis out of a query string", () => {
    const query = parseBoardQuery(
      "area=web&repo=api&assignee=gary&actor=person-1&priority=P0&state=blocked&kind=task&level=include:1,2&project=proj-1&search=auth",
    );
    expect(query.filters).toEqual({
      area: "web",
      repo: "api",
      assignee: "gary",
      actor: "person-1",
      priority: "P0",
      state: "blocked",
      kind: "task",
      level: { mode: "include", levels: [1, 2] },
      project: "proj-1",
      search: "auth",
    });
  });

  it("reads the sort and its direction", () => {
    const query = parseBoardQuery("sort=priority&direction=asc");
    expect(query.sort).toBe("priority");
    expect(query.direction).toBe("asc");
  });

  it("falls back to the default ordering rather than trusting an unknown sort key", () => {
    // Dropping the `.includes` guard in `parseBoardQuery` would let
    // `sort=nonsense` reach the API and turn a hand-edited URL into a 400
    // the reader cannot see the cause of.
    const query = parseBoardQuery("sort=nonsense&direction=sideways");
    expect(query.sort).toBe("created");
    expect(query.direction).toBe("desc");
  });

  it("drops a priority outside the vocabulary rather than passing it through", () => {
    expect(parseBoardQuery("priority=P9").filters.priority).toBeUndefined();
    expect(parseBoardQuery("kind=elephant").filters.kind).toBeUndefined();
  });

  // The trust axis (MILESTONES.md #131). Held to the same URL contract as
  // every other axis: it round-trips, it survives a paste, and a value
  // outside its vocabulary is dropped rather than forwarded to an API that
  // would refuse it with a status the reader cannot act on.
  it("carries trust through the round trip, so a trust-filtered board is linkable", () => {
    for (const value of ["trusted", "unverified", "verified"]) {
      const query = parseBoardQuery(`trust=${value}`);
      expect(query.filters.trust).toBe(value);
      // Re-emitting reproduces the same address — which is what makes a
      // pasted URL give back the same board, and what lets a saved view of
      // it match by string equality.
      expect(boardQueryString(query)).toBe(`trust=${value}`);
    }
  });

  it("drops a trust value outside the vocabulary rather than passing it through", () => {
    expect(parseBoardQuery("trust=maybe").filters.trust).toBeUndefined();
    // …and the board that produces is simply unfiltered on that axis,
    // rather than an error page.
    expect(boardQueryString(parseBoardQuery("trust=maybe"))).toBe("");
  });

  it("emits trust in the one fixed position, whatever order it arrived in", () => {
    // Two spellings of one board would break the saved-view marker, which
    // decides "you are looking at this view" by comparing query strings.
    const a = boardQueryString(parseBoardQuery("trust=verified&area=web&priority=P0"));
    const b = boardQueryString(parseBoardQuery("priority=P0&trust=verified&area=web"));
    expect(a).toBe(b);
    expect(a).toBe("area=web&priority=P0&trust=verified");
  });

  it("counts trust as a narrowed axis, so the clear control offers to undo it", () => {
    expect(activeFilterCount(parseBoardQuery("trust=unverified").filters)).toBe(1);
  });

  it("sends trust on the request as well as showing it in the address", () => {
    // The address and the API share one vocabulary; a filter applied to one
    // and not the other is how a board comes to disagree with its own URL.
    const params = boardRequestParams(parseBoardQuery("trust=unverified"), {
      column: "backlog",
    });
    expect(params.get("trust")).toBe("unverified");
  });

  it("treats an empty or whitespace-only value as no filter at all", () => {
    // `search=` is what a cleared text box leaves behind. Keeping it would
    // send an empty string to a schema requiring one character — a cleared
    // box would 400 rather than widening the board.
    //
    // `level` is present in the result because absent MEANS the board
    // default (`include(1)`), not "unfiltered" — the one axis where a
    // missing parameter says something. `isFiltered` still reports false,
    // which is the fact this test is really about: a board nobody has
    // narrowed must not claim a filter is applied.
    expect(parseBoardQuery("search=&area=%20%20").filters).toEqual({
      level: { mode: "include", levels: [1] },
    });
    expect(isFiltered(parseBoardQuery("search=").filters)).toBe(false);
  });

  it("accepts anything with a get(), not only a URLSearchParams", () => {
    // Next's `ReadonlyURLSearchParams` is not an instance of
    // `URLSearchParams` in every runtime — reading it structurally is what
    // keeps this working in the app as well as in this harness.
    const source = { get: (name: string) => (name === "area" ? "web" : null) };
    expect(parseBoardQuery(source).filters.area).toBe("web");
  });
});

describe("boardQueryString", () => {
  it("round-trips every filter the parser can read", () => {
    const original =
      "area=web&repo=api&assignee=gary&actor=person-1&priority=P0&state=blocked&kind=task&search=auth";
    const reparsed = parseBoardQuery(boardQueryString(parseBoardQuery(original)));
    expect(reparsed.filters).toEqual(parseBoardQuery(original).filters);
  });

  it("omits a default sort so the common address is the short one", () => {
    expect(boardQueryString(emptyBoardQuery())).toBe("");
    // …and the round trip still holds, because an absent key parses to the
    // same default. Writing the default instead would put `sort=created` in
    // every address for no information.
    expect(parseBoardQuery("").sort).toBe("created");
  });

  it("writes a non-default sort, so a link that carries one means it", () => {
    const query: BoardQuery = { filters: {}, sort: "priority", direction: "asc" };
    expect(boardQueryString(query)).toBe("sort=priority&direction=asc");
  });

  it("emits parameters in one fixed order, so one board has one address", () => {
    // Two readers reaching the same board by different routes must produce
    // the same string, or the same board is two links and neither the saved
    // views nor the sidebar's current-view marker can match.
    const a = boardQueryString(
      parseBoardQuery("search=auth&priority=P0&area=web&repo=api&kind=task"),
    );
    const b = boardQueryString(
      parseBoardQuery("kind=task&repo=api&area=web&priority=P0&search=auth"),
    );
    expect(a).toBe(b);
    expect(a).toBe("area=web&repo=api&priority=P0&kind=task&search=auth");
  });
});

describe("boardHref", () => {
  it("is the bare path when nothing is narrowed", () => {
    // A trailing `?` reads as a filter that failed to apply, and it would
    // also make the sidebar's current-view comparison miss on the
    // unfiltered board.
    expect(boardHref(emptyBoardQuery())).toBe("/board");
  });

  it("carries the query when something is", () => {
    expect(boardHref(parseBoardQuery("area=web"))).toBe("/board?area=web");
  });
});

describe("boardRequestParams", () => {
  it("always sends the sort, even when it is the default", () => {
    // The address omits a default for readability. The REQUEST must not:
    // omitting it would require this module's default and the operation's
    // default to stay equal forever while being declared in different files.
    const params = boardRequestParams(emptyBoardQuery(), { column: "backlog" });
    expect(params.get("sort")).toBe("created");
    expect(params.get("direction")).toBe("desc");
  });

  it("carries every filter to the API under the same names the URL used", () => {
    const query = parseBoardQuery("area=web&assignee=gary&actor=person-1&search=auth");
    const params = boardRequestParams(query, { column: "in_progress" });
    expect(params.get("area")).toBe("web");
    expect(params.get("assignee")).toBe("gary");
    expect(params.get("actor")).toBe("person-1");
    expect(params.get("search")).toBe("auth");
    expect(params.get("column")).toBe("in_progress");
  });

  it("keeps the filters when paging, so a second page is drawn from the same set", () => {
    // A "show more" that dropped the filters would page an unfiltered
    // sequence into a filtered column — and because the cursor is keyset on
    // the sort key, a page requested under a different sort is drawn from a
    // sequence the cursor does not belong to at all.
    const query = parseBoardQuery("area=web&sort=priority&direction=asc");
    const params = boardRequestParams(query, { column: "backlog", cursor: "item-9" });
    expect(params.get("area")).toBe("web");
    expect(params.get("sort")).toBe("priority");
    expect(params.get("direction")).toBe("asc");
    expect(params.get("cursor")).toBe("item-9");
  });
});

describe("withFilter and withoutFilters", () => {
  it("clears an axis when given undefined rather than writing an empty value", () => {
    const query = withFilter(parseBoardQuery("area=web"), "area", undefined);
    expect(query.filters.area).toBeUndefined();
    expect(boardQueryString(query)).toBe("");
  });

  it("keeps the ordering when every filter is cleared", () => {
    // "Clear filters" names one thing. A control that also reset the sort
    // would be doing something its own label does not mention.
    const cleared = withoutFilters(parseBoardQuery("area=web&sort=priority&direction=asc"));
    // The level returns to its DEFAULT rather than to nothing: "no level
    // filter" is not a state this board has, and leaving the key off would
    // describe a board that still hides projects and subtasks while
    // reporting it does not.
    expect(cleared.filters).toEqual({ level: { mode: "include", levels: [1] } });
    expect(isFiltered(cleared.filters)).toBe(false);
    expect(cleared.sort).toBe("priority");
    expect(cleared.direction).toBe("asc");
  });
});

describe("activeFilterCount", () => {
  it("counts the narrowed axes, so the clear control says what it will undo", () => {
    expect(activeFilterCount(parseBoardQuery("").filters)).toBe(0);
    expect(activeFilterCount(parseBoardQuery("area=web").filters)).toBe(1);
    expect(activeFilterCount(parseBoardQuery("area=web&priority=P0&search=x").filters)).toBe(3);
  });

  it("does not count the sort, which is not a filter", () => {
    // Counting it would make the clear control offer to undo something it
    // does not touch.
    expect(activeFilterCount(parseBoardQuery("sort=priority&direction=asc").filters)).toBe(0);
  });
});
