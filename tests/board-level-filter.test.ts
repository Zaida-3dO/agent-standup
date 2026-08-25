// The level filter's codec and semantics — the depth-based axis.
//
// Every assertion below names the single-character source change it would
// catch, because a test whose failure mode nobody can state is a test that
// gets deleted the first time it is inconvenient.
import { describe, expect, it } from "vitest";
import {
  BOARD_LEVEL_CHOICES,
  BOARD_LEVEL_TOP_BUCKET,
  activeFilterCount,
  boardQueryString,
  boardRequestParams,
  defaultLevelFilter,
  emptyBoardQuery,
  formatLevelFilter,
  isFiltered,
  levelIsDefault,
  normaliseLevelFilter,
  normaliseLevels,
  parseBoardQuery,
  parseLevelFilter,
  projectBoardHref,
  withFilter,
  withoutFilters,
} from "@/lib/board/filters";

describe("the level vocabulary", () => {
  it("ends in a bucket rather than a hard ceiling, because nesting is unbounded", () => {
    // `items.max_depth` is a runaway guard an installation configures, not a
    // limit the schema encodes. A fixed list of individual levels would leave
    // rows in a deeply-configured store unreachable by any choice at all.
    // Changing the last entry from a bucket to a plain level is the change
    // this catches.
    const last = BOARD_LEVEL_CHOICES[BOARD_LEVEL_CHOICES.length - 1];
    expect(last).toBe(BOARD_LEVEL_TOP_BUCKET);
    expect(BOARD_LEVEL_CHOICES).toContain(0);
  });
});

describe("the board's default level filter", () => {
  it("is include(1) — the tasks, without the projects above or the subtasks beneath", () => {
    // The default the whole feature turns on, and BOTH exclusions are load
    // bearing. A project's row is a rollup of its own subtree, so listing
    // every project beside the work inside it shows the same work twice; a
    // subtask is work the card above it already counts and now states, so
    // listing it separately shows that work twice too. Widening this to
    // `exclude(0)` — the default before subtask rollups existed — puts every
    // subtask back on the board as a peer of its own parent.
    expect(defaultLevelFilter()).toEqual({ mode: "include", levels: [1] });
  });

  it("applies when the URL says nothing at all", () => {
    // Deleting the `?? defaultLevelFilter()` in `parseBoardQuery` is the
    // change this catches: an absent `level` would become "unfiltered" and
    // every project AND every subtask would reappear in the item list.
    expect(parseBoardQuery("").filters.level).toEqual({ mode: "include", levels: [1] });
    expect(parseBoardQuery("area=web").filters.level).toEqual({ mode: "include", levels: [1] });
  });

  it("does not count as a narrowed axis", () => {
    // Otherwise an untouched board carries a permanent "Clear 1 filter" and
    // an empty column blames a filter nobody set.
    expect(isFiltered(parseBoardQuery("").filters)).toBe(false);
    expect(activeFilterCount(parseBoardQuery("").filters)).toBe(0);
    // ...but a level the reader actually chose does count, or the control
    // would narrow the board while reporting nothing is applied. `include:2`
    // rather than `include:1` here precisely BECAUSE `include:1` is now the
    // default: a chosen level that happens to equal the default is not a
    // narrowing, and asserting on it would test the opposite of this case.
    expect(activeFilterCount(parseBoardQuery("level=include:2").filters)).toBe(1);
    expect(isFiltered(parseBoardQuery("level=include:2").filters)).toBe(true);
  });

  it("does not count as narrowed even when the reader spells it out", () => {
    // `?level=include:1` and no `level` at all are the same board, so the
    // address bar must not report one as filtered and the other as not —
    // this is `levelIsDefault` doing its job across the rename of what the
    // default IS, not just across its absence.
    expect(isFiltered(parseBoardQuery("level=include:1").filters)).toBe(false);
    expect(activeFilterCount(parseBoardQuery("level=include:1").filters)).toBe(0);
  });

  it("survives clearing every filter, because no-level-filter is not a state", () => {
    const cleared = withoutFilters(parseBoardQuery("area=web&level=include:2"));
    expect(cleared.filters.level).toEqual({ mode: "include", levels: [1] });
  });
});

describe("include and exclude are different questions", () => {
  it("round-trips include(1,2) — only levels 1 and 2", () => {
    const parsed = parseLevelFilter("include:1,2");
    expect(parsed).toEqual({ mode: "include", levels: [1, 2] });
    expect(formatLevelFilter(parsed!)).toBe("include:1,2");
  });

  it("round-trips exclude(0)", () => {
    expect(parseLevelFilter("exclude:0")).toEqual({ mode: "exclude", levels: [0] });
  });

  it("keeps the two modes distinct through a full URL round trip", () => {
    // Collapsing the mode — reading every selection as `include`, say —
    // would turn "everything except projects" into "projects only", which is
    // the complement of the board the reader asked for and would still look
    // like a working filter.
    const include = parseBoardQuery("level=include:0").filters.level;
    const exclude = parseBoardQuery("level=exclude:0").filters.level;
    expect(include).toEqual({ mode: "include", levels: [0] });
    expect(exclude).toEqual({ mode: "exclude", levels: [0] });
    expect(include).not.toEqual(exclude);
  });
});

describe("one filter selection has one address", () => {
  it("sorts and de-duplicates the levels", () => {
    // The value-level half of the determinism `BOARD_FILTER_PARAMS` ordering
    // gives the parameters. Without it, ticking 2 then 1 and ticking 1 then
    // 2 are two different query strings for one board — and the saved-view
    // marker decides "you are looking at this view" by string equality.
    expect(normaliseLevels([2, 1, 2])).toEqual([1, 2]);
    expect(formatLevelFilter({ mode: "include", levels: [3, 1, 1] })).toBe("include:1,3");
    expect(normaliseLevelFilter({ mode: "exclude", levels: [2, 0] })).toEqual({
      mode: "exclude",
      levels: [0, 2],
    });
  });

  it("produces the same query string whichever order the levels arrived in", () => {
    const a = boardQueryString(parseBoardQuery("level=include:2,1"));
    const b = boardQueryString(parseBoardQuery("level=include:1,2"));
    expect(a).toBe(b);
    expect(a).toBe("level=include%3A1%2C2");
  });

  it("omits the default from an address, so the common board is the short URL", () => {
    expect(levelIsDefault(defaultLevelFilter())).toBe(true);
    expect(boardQueryString(emptyBoardQuery())).toBe("");
    // A default reached by clicking rather than by loading /board is still
    // the default, so a reader who unticked and re-ticked a level lands back
    // on the address they started at rather than beside it.
    expect(
      boardQueryString(withFilter(emptyBoardQuery(), "level", { mode: "include", levels: [1] })),
    ).toBe("");
    // ...and a NON-default level is written, or a link that carries one
    // would silently mean the default.
    expect(boardQueryString(parseBoardQuery("level=include:2"))).toBe("level=include%3A2");
    // `exclude:0` is a REAL selection now rather than the default spelling:
    // it is the board that shows subtasks as peers again, so an address has
    // to carry it.
    expect(boardQueryString(parseBoardQuery("level=exclude:0"))).toBe("level=exclude%3A0");
  });

  it("always sends the level to the API, including the default", () => {
    // `get_board` has NO default for `level`, so a request that omitted it
    // asks for an unnarrowed board — every project back in the item list.
    // Deleting the `?? defaultLevelFilter()` in `boardRequestParams` is the
    // change this catches.
    const params = boardRequestParams(emptyBoardQuery(), { column: "backlog" });
    expect(params.get("level")).toBe("include:1");
    const narrowed = boardRequestParams(parseBoardQuery("level=include:1,2"), {
      column: "backlog",
    });
    expect(narrowed.get("level")).toBe("include:1,2");
  });
});

describe("a malformed level value renders a board rather than an error", () => {
  it("drops anything that is not a complete, well-formed selection", () => {
    // The same rule an unknown `priority` follows: a hand-edited URL should
    // render a board the reader can see and correct, not a 400 they cannot.
    expect(parseLevelFilter("nonsense")).toBeUndefined();
    expect(parseLevelFilter("include")).toBeUndefined();
    expect(parseLevelFilter("sideways:1")).toBeUndefined();
    expect(parseLevelFilter("include:1,,2")).toBeUndefined();
    expect(parseLevelFilter("include:one")).toBeUndefined();
    expect(parseLevelFilter("include:-1")).toBeUndefined();
  });

  it("refuses an empty segment rather than reading it as level 0", () => {
    // `Number("")` is 0, so a lenient parse turns `include:` into "projects
    // only" — the one value that most changes what the board shows, arrived
    // at from a value that named no level at all.
    expect(parseLevelFilter("include:")).toBeUndefined();
    expect(parseBoardQuery("level=include:").filters.level).toEqual({
      mode: "include",
      levels: [1],
    });
  });
});

describe("the project card board link", () => {
  it("scopes the board to the project and leaves the level at its default", () => {
    // The address is the SHORT spelling on purpose: an absent `level` parses
    // to exactly the default, and `boardQueryString` omits a default so one
    // board has one address. Writing it explicitly would give this link a
    // different string from the one the filter bar produces the moment the
    // reader touches any other control, which is what breaks the saved-view
    // marker equality check.
    expect(projectBoardHref("proj-1")).toBe("/board?project=proj-1");
    const reparsed = parseBoardQuery("project=proj-1");
    expect(reparsed.filters.project).toBe("proj-1");
    expect(reparsed.filters.level).toEqual({ mode: "include", levels: [1] });
  });
});
