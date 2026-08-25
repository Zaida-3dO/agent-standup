// The layout parameter's URL contract — MILESTONES.md T6 §3.
//
// Two acceptance criteria live entirely in this file, because both are
// properties of the codec rather than of any component:
//
//   - "toggling between layouts preserves filter state", and
//   - "the layout choice itself belongs in the URL, so a list view can be
//     linked and reloaded".
//
// As in `board-filters-url.test.ts`, the single-character source change each
// assertion is protecting against is named in its comment. A test whose
// failure mode nobody can state is a test that gets deleted the first time
// it is inconvenient.
import { describe, expect, it } from "vitest";
import {
  BOARD_FILTER_PARAMS,
  BOARD_LAYOUTS,
  BOARD_LAYOUT_PARAM,
  DEFAULT_BOARD_LAYOUT,
  boardHref,
  boardQueryString,
  boardRequestParams,
  defaultLevelFilter,
  emptyBoardQuery,
  isFiltered,
  activeFilterCount,
  layoutOf,
  parseBoardQuery,
  withFilter,
  withLayout,
  withoutFilters,
  type BoardQuery,
} from "@/lib/board/filters";

describe("the layout parameter's vocabulary", () => {
  it("is exactly the two shapes, spelled the way the URL spells them", () => {
    // Literal, not derived from the constant under test — deriving it would
    // make the assertion vacuous, passing however the values were spelled.
    // Renaming `list` to `table` here is the change that breaks every link
    // anyone has saved to a list view, and this is what catches it.
    expect([...BOARD_LAYOUTS]).toEqual(["board", "list"]);
  });

  it("is carried under `layout`", () => {
    // The parameter NAME is the contract with anything that builds a link
    // to a list view. Changing this one string silently breaks them all,
    // because `parseBoardQuery` ignores a parameter it does not recognise
    // rather than refusing it.
    expect(BOARD_LAYOUT_PARAM).toBe("layout");
  });

  it("defaults to the kanban", () => {
    // Flipping this to `"list"` would change what every existing `/board`
    // link renders — the whole installed base of bookmarks and chip links
    // — without any of them changing a character.
    expect(DEFAULT_BOARD_LAYOUT).toBe("board");
  });

  it("is NOT one of the filter parameters", () => {
    // The load-bearing separation. `BOARD_FILTER_PARAMS` is walked by
    // `boardRequestParams` to build the API request and by
    // `isFiltered`/`activeFilterCount` to decide whether an empty region
    // blames a filter. Adding `"layout"` to that list — a one-word change
    // — would forward an unknown parameter to `get_board` (a 400) AND put
    // a permanent "1 filter" on an untouched board.
    expect([...BOARD_FILTER_PARAMS]).not.toContain("layout");
  });
});

describe("reading a layout out of a URL", () => {
  it("reads `layout=list`", () => {
    expect(parseBoardQuery("layout=list").layout).toBe("list");
  });

  it("resolves an absent layout to the kanban", () => {
    // An absent parameter means the default, exactly as an absent `sort`
    // does — which is what lets the address stay short.
    expect(parseBoardQuery("").layout).toBe("board");
    expect(layoutOf(parseBoardQuery(""))).toBe("board");
  });

  it("drops an unrecognised layout rather than honouring it", () => {
    // A hand-edited `layout=table` renders the kanban, which the reader can
    // see and correct with the toggle — not a blank region drawn by a
    // component that does not exist, and not a 400 they cannot act on.
    // Deleting the `.includes` guard in `parseBoardQuery` is what this
    // catches: without it, `layout` would be `"table"` here.
    expect(parseBoardQuery("layout=table").layout).toBe("board");
    expect(parseBoardQuery("layout=").layout).toBe("board");
  });

  it("reads the layout alongside the filters rather than instead of them", () => {
    // The parse-side half of "the toggle preserves filter state": a URL
    // carrying both must yield both. A parser that returned early on
    // `layout` would pass every test above and fail this one.
    const query = parseBoardQuery("area=web&priority=P0&sort=name&layout=list");
    expect(query.layout).toBe("list");
    expect(query.filters.area).toBe("web");
    expect(query.filters.priority).toBe("P0");
    expect(query.sort).toBe("name");
  });
});

describe("writing a layout back to a URL", () => {
  it("emits `layout=list` for the list", () => {
    const query = withLayout(emptyBoardQuery(), "list");
    expect(boardQueryString(query)).toBe("layout=list");
    expect(boardHref(query)).toBe("/board?layout=list");
  });

  it("omits the layout when it is the default", () => {
    // **One board, one address.** A saved view is matched by STRING
    // EQUALITY, so emitting `layout=board` on a default board would give
    // every already-saved view a different string from the one the bar now
    // produces and silently stop each one marking itself current.
    // Deleting the `!== DEFAULT_BOARD_LAYOUT` guard in `boardQueryString`
    // makes this `"layout=board"`.
    expect(boardQueryString(withLayout(emptyBoardQuery(), "board"))).toBe("");
    expect(boardHref(withLayout(emptyBoardQuery(), "board"))).toBe("/board");
  });

  it("omits the layout when the query never mentioned one", () => {
    // `emptyBoardQuery` leaves `layout` undefined, and an undefined layout
    // must not emit `layout=undefined`. Changing the guard from
    // `query.layout !== undefined && …` to just the second clause is what
    // this catches.
    expect(boardQueryString(emptyBoardQuery())).toBe("");
  });

  it("emits the layout LAST, after every filter and the sort", () => {
    // The order is the contract that keeps one board at one address. Every
    // pre-existing parameter must appear in exactly the position it did
    // this parameter is appended, so an already-saved view still matches
    // the string the bar builds — hence the layout goes on the end.
    const query: BoardQuery = {
      filters: { area: "web" },
      sort: "name",
      direction: "asc",
      layout: "list",
    };
    expect(boardQueryString(query)).toBe("area=web&sort=name&direction=asc&layout=list");
  });
});

describe("the round trip", () => {
  it("survives a layout alongside every other axis", () => {
    const query: BoardQuery = {
      // `level` is stated explicitly because `parseBoardQuery` always
      // resolves an absent one to the board default — so a fixture that
      // omitted it would not be the same object that comes back, and the
      // round trip would look broken when it is the default doing its job.
      filters: {
        area: "web",
        repo: "agent-standup",
        priority: "P1",
        search: "list",
        level: defaultLevelFilter(),
      },
      sort: "updated",
      direction: "asc",
      layout: "list",
    };
    const reparsed = parseBoardQuery(boardQueryString(query));
    expect(reparsed.layout).toBe("list");
    expect(reparsed.filters).toEqual(query.filters);
    expect(reparsed.sort).toBe("updated");
    expect(reparsed.direction).toBe("asc");
  });
});

describe("switching layout preserves the view", () => {
  it("carries every filter, the sort and the direction across the switch", () => {
    // **This IS the acceptance criterion**, asserted on the encoder rather
    // than through a rendered component, because the encoder is where it is
    // actually decided. `withLayout` spreading `...query` is the one line
    // that makes it true. Drop the spread, build a fresh object literal,
    // and this is the assertion that fails.
    const kanban: BoardQuery = {
      filters: { area: "web", priority: "P0", search: "drag" },
      sort: "priority",
      direction: "asc",
      layout: "board",
    };
    const list = withLayout(kanban, "list");
    expect(list.filters).toEqual(kanban.filters);
    expect(list.sort).toBe(kanban.sort);
    expect(list.direction).toBe(kanban.direction);
    expect(list.layout).toBe("list");
  });

  it("survives a full round trip through the address bar", () => {
    // The end-to-end version of the same criterion: what a reader actually
    // does is follow the toggle's href, and the browser re-parses it. So
    // the property has to hold through encode-then-decode, not merely
    // in-memory.
    const kanban = parseBoardQuery("area=web&priority=P0&sort=name&direction=asc");
    const href = boardHref(withLayout(kanban, "list"));
    const reparsed = parseBoardQuery(href.slice(href.indexOf("?") + 1));

    expect(reparsed.layout).toBe("list");
    expect(reparsed.filters.area).toBe("web");
    expect(reparsed.filters.priority).toBe("P0");
    expect(reparsed.sort).toBe("name");
    expect(reparsed.direction).toBe("asc");
  });

  it("switching back to the kanban keeps the filters too", () => {
    // The other direction, which a `withLayout` special-cased on `"list"`
    // would fail.
    const list = parseBoardQuery("repo=agent-standup&layout=list");
    const back = withLayout(list, "board");
    expect(back.filters.repo).toBe("agent-standup");
    expect(boardHref(back)).toBe("/board?repo=agent-standup");
  });
});

describe("the layout is not a filter", () => {
  it("does not make an unfiltered board look filtered", () => {
    // If `layout` were counted as narrowing, an untouched list view would
    // report one active filter — and every empty section would offer to
    // clear a filter the reader never set, pointing at rows that do not
    // exist.
    const query = withLayout(emptyBoardQuery(), "list");
    expect(isFiltered(query.filters)).toBe(false);
    expect(activeFilterCount(query.filters)).toBe(0);
  });

  it("is not sent to the board API", () => {
    // `get_board` has no `layout` input. Forwarding one is a 400 on every
    // request the list makes — i.e. the list would never render at all.
    // This is what keeps `boardRequestParams` walking `BOARD_FILTER_PARAMS`
    // rather than the whole query object.
    const params = boardRequestParams(withLayout(emptyBoardQuery(), "list"), {
      column: "backlog",
    });
    expect(params.get("layout")).toBeNull();
    expect(params.has("layout")).toBe(false);
  });

  it("survives clearing every filter", () => {
    // Clearing filters must not also throw the reader back to the kanban —
    // that would be the interface undoing a choice the reader did not ask
    // it to undo. `withoutFilters` spreading `...query` is what makes this
    // hold; rebuilding the object without the spread is what it catches.
    const query = withLayout(withFilter(parseBoardQuery("layout=list"), "area", "web"), "list");
    const cleared = withoutFilters(query);
    expect(cleared.layout).toBe("list");
    expect(isFiltered(cleared.filters)).toBe(false);
    expect(boardHref(cleared)).toBe("/board?layout=list");
  });

  it("survives changing a filter", () => {
    // `withFilter` spreads the query too. A reader who narrows by area
    // while in the list must stay in the list.
    const query = withFilter(parseBoardQuery("layout=list"), "area", "web");
    expect(query.layout).toBe("list");
    expect(boardHref(query)).toBe("/board?area=web&layout=list");
  });
});
