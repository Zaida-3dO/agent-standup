// Saved board views — MILESTONES.md #75.
//
// The acceptance criterion these serve is "a saved view survives a reload
// and appears in the sidebar". The reload half is the settings key (asserted
// in `tests/settings-registry.test.ts`, which validates every default
// against its own schema) and the round trip through the stored query
// string, which is what this file covers; the sidebar half is
// `savedViewLinksFrom`, below.
import { describe, expect, it } from "vitest";
import {
  SAVED_VIEWS_KEY,
  SAVED_VIEWS_MAX,
  SAVED_VIEW_NAME_MAX,
  findMatchingView,
  normaliseViewName,
  removeSavedView,
  savedViewNameProblem,
  savedViewsSchema,
  upsertSavedView,
  type SavedView,
} from "@/lib/board/saved-views";
import { boardHrefForQuery, currentHrefFrom, savedViewLinksFrom } from "@/lib/nav/saved-view-links";
import { viewDeleted, viewSaved } from "@/lib/board/filter-state";
import { boardQueryString, parseBoardQuery } from "@/lib/board/filters";
import { SETTINGS_REGISTRY } from "@/lib/settings/registry";

function view(name: string, query: string): SavedView {
  return { name, query, pinned: true };
}

describe("the settings key", () => {
  it("is registered, so a saved view survives a reload rather than living in the tab", () => {
    // Without a registry entry, `PUT /api/settings/ui.saved_views` is
    // refused as an unknown key and every save silently fails — the view
    // would appear until the page was reloaded and then be gone, which is
    // the acceptance criterion inverted.
    expect(SAVED_VIEWS_KEY).toBe("ui.saved_views");
    expect(Object.keys(SETTINGS_REGISTRY)).toContain(SAVED_VIEWS_KEY);
  });

  it("defaults to no views, so a fresh installation renders no sidebar section", () => {
    expect(SETTINGS_REGISTRY["ui.saved_views"].default).toEqual([]);
  });

  it("is filed under Interface, which is what its ui. prefix requires", () => {
    // `checkNoUnmappedPrefix` enforces this across the registry; asserting
    // it here names the reason rather than leaving a reader to discover it
    // from a failing invariant test.
    expect(SETTINGS_REGISTRY["ui.saved_views"].category).toBe("Interface");
  });
});

describe("the stored shape", () => {
  it("accepts a view with an empty query — the unfiltered board is worth pinning", () => {
    expect(
      savedViewsSchema.safeParse([{ name: "Everything", query: "", pinned: true }]).success,
    ).toBe(true);
  });

  it("defaults pinned to true, so a view written without the flag still shows", () => {
    const parsed = savedViewsSchema.parse([{ name: "Mine", query: "area=web" }]);
    expect(parsed[0]!.pinned).toBe(true);
  });

  it("refuses an unnamed view and a list past the cap", () => {
    expect(savedViewsSchema.safeParse([{ name: "", query: "" }]).success).toBe(false);
    const tooMany = Array.from({ length: SAVED_VIEWS_MAX + 1 }, (_, i) => view(`v${i}`, ""));
    expect(savedViewsSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe("upsertSavedView", () => {
  it("adds a view that is not there", () => {
    expect(upsertSavedView([], view("Mine", "area=web"))).toEqual([view("Mine", "area=web")]);
  });

  it("overwrites by name rather than appending a second entry", () => {
    // Saving over a view is how a reader adjusts one. Appending instead
    // would leave two identically named chips and make the sidebar unusable
    // after a few adjustments.
    const next = upsertSavedView([view("Mine", "area=web")], view("Mine", "area=api"));
    expect(next).toHaveLength(1);
    expect(next[0]!.query).toBe("area=api");
  });

  it("treats names differing only in case or space as the same view", () => {
    const next = upsertSavedView([view("Mine", "area=web")], view("  mine  ", "area=api"));
    expect(next).toHaveLength(1);
  });

  it("keeps the view in place, so editing does not move it in the sidebar", () => {
    const next = upsertSavedView(
      [view("A", "a=1"), view("B", "b=1"), view("C", "c=1")],
      view("B", "b=2"),
    );
    expect(next.map((v) => v.name)).toEqual(["A", "B", "C"]);
    expect(next[1]!.query).toBe("b=2");
  });
});

describe("removeSavedView", () => {
  it("removes by name, case-insensitively", () => {
    expect(removeSavedView([view("Mine", "a=1")], "MINE")).toEqual([]);
  });

  it("is a no-op for a name that is not there — the end state is the same", () => {
    const views = [view("Mine", "a=1")];
    expect(removeSavedView(views, "Other")).toEqual(views);
  });
});

describe("savedViewNameProblem", () => {
  it("refuses an empty name with a sentence, not silence", () => {
    expect(savedViewNameProblem([], "  ")?.reason).toMatch(/name/i);
  });

  it("refuses a name past the length cap", () => {
    expect(savedViewNameProblem([], "x".repeat(SAVED_VIEW_NAME_MAX + 1))).not.toBeNull();
    expect(savedViewNameProblem([], "x".repeat(SAVED_VIEW_NAME_MAX))).toBeNull();
  });

  it("refuses a NEW view at the cap but still allows saving over an existing one", () => {
    // Overwriting cannot push the list past the limit, so refusing it would
    // block the one action that is always safe at the cap — a reader at
    // twenty views would be unable to adjust any of them.
    const full = Array.from({ length: SAVED_VIEWS_MAX }, (_, i) => view(`v${i}`, ""));
    expect(savedViewNameProblem(full, "new one")).not.toBeNull();
    expect(savedViewNameProblem(full, "v3")).toBeNull();
  });
});

describe("viewSaved", () => {
  it("stores the board's query string, so applying a view is opening its link", () => {
    const query = parseBoardQuery("area=web&priority=P0&sort=priority&direction=asc");
    const result = viewSaved([], "My P0s", query);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.views[0]!.query).toBe(boardQueryString(query));
    // The round trip is the property that matters: the stored string must
    // reproduce the same board.
    expect(parseBoardQuery(result.views[0]!.query).filters).toEqual(query.filters);
    expect(parseBoardQuery(result.views[0]!.query).sort).toBe("priority");
  });

  it("keeps the reader's capitalisation while matching case-insensitively", () => {
    const result = viewSaved([], "  My P0s  ", parseBoardQuery(""));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.views[0]!.name).toBe("My P0s");
    expect(normaliseViewName(result.views[0]!.name)).toBe("my p0s");
  });

  it("reports the refusal rather than saving something invalid", () => {
    const result = viewSaved([], "   ", parseBoardQuery(""));
    expect(result.ok).toBe(false);
  });
});

describe("viewDeleted", () => {
  it("drops the named view", () => {
    expect(viewDeleted([view("A", ""), view("B", "")], "A").map((v) => v.name)).toEqual(["B"]);
  });
});

describe("findMatchingView", () => {
  it("matches on the exact stored query, which is why the emitted order is fixed", () => {
    const views = [view("Mine", "area=web&priority=P0")];
    expect(findMatchingView(views, "area=web&priority=P0")?.name).toBe("Mine");
    // The same filters in a different order are a different string. That is
    // exactly why `boardQueryString` emits one fixed order — without it, a
    // view would fail to mark itself active on the board it describes.
    expect(findMatchingView(views, "priority=P0&area=web")).toBeUndefined();
  });
});

describe("the sidebar's links", () => {
  it("turns a stored query into a board href", () => {
    expect(boardHrefForQuery("area=web")).toBe("/board?area=web");
  });

  it("gives the unfiltered view a bare path, with no trailing question mark", () => {
    // A trailing `?` would also make the current-href comparison miss, so a
    // pinned "everything" view would never mark itself current.
    expect(boardHrefForQuery("")).toBe("/board");
  });

  it("renders only pinned views, and counts an absent flag as pinned", () => {
    const links = savedViewLinksFrom([
      { name: "Pinned", query: "a=1", pinned: true },
      { name: "Not pinned", query: "b=1", pinned: false },
      { name: "Legacy", query: "c=1" },
    ]);
    expect(links.map((l) => l.name)).toEqual(["Pinned", "Legacy"]);
  });

  it("compares path AND query, because every view points at the same path", () => {
    // A path-only comparison would mark every pinned view current at once
    // the moment the reader opened the board.
    expect(currentHrefFrom("/board", "area=web")).toBe("/board?area=web");
    expect(currentHrefFrom("/board", "")).toBe("/board");
    expect(currentHrefFrom(undefined, "area=web")).toBeNull();
  });
});
