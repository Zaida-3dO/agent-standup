// The "More filters" picker — which controls the header renders, and where
// that choice is kept.
//
// The split this file exists to pin: WHICH filters are visible is
// browser-local, and what each filter is SET to is the URL. A regression
// that moved visibility into the query string would make one reader's
// chosen control set travel in a shared link and in a saved view, which is
// the defect the split prevents.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISIBLE_FILTERS,
  FILTER_VISIBILITY_CHOICES,
  canHide,
  isFilterVisible,
  normaliseVisibleFilters,
  visibilityToggled,
} from "@/lib/board/visible-filters";
import {
  VISIBLE_FILTERS_STORAGE_KEY,
  readVisibleFilters,
  resetVisibleFiltersCache,
  setVisibleFilters,
  subscribeToVisibleFilters,
  visibleFiltersServerSnapshot,
  visibleFiltersSnapshot,
  writeVisibleFilters,
  type VisibleFiltersStorage,
} from "@/lib/board/visible-filters-client";
import {
  boardQueryString,
  defaultLevelFilter,
  parseBoardQuery,
  type BoardFilters,
} from "@/lib/board/filters";

/** A `localStorage` stand-in — the whole surface this module uses. */
function fakeStorage(seed: Record<string, string> = {}): VisibleFiltersStorage & {
  readonly map: Map<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("visibility is browser-local and the URL never learns about it", () => {
  it("round-trips a chosen set through storage", () => {
    // The acceptance criterion for the persistence half: a reader who turns
    // the project control on and comes back finds it on.
    const storage = fakeStorage();
    writeVisibleFilters(["area", "project"], storage);
    expect(readVisibleFilters(storage)).toEqual(["area", "project"]);
  });

  it("keeps the chosen set out of the board address entirely", () => {
    // The whole reason the two live in different places. Writing a
    // visibility preference and then serialising the board must not change
    // the board's address by one character — otherwise a link shared with
    // someone else rearranges their header, and a saved view (stored as a
    // query string, matched by string equality) silently becomes a
    // different view for anyone whose picker differs.
    const storage = fakeStorage();
    const query = parseBoardQuery("area=web&priority=P0");
    const before = boardQueryString(query);
    writeVisibleFilters(["area"], storage);
    expect(boardQueryString(query)).toBe(before);
    // ...and the stored value names no board state — only axis names.
    const stored = storage.map.get(VISIBLE_FILTERS_STORAGE_KEY) ?? "";
    expect(stored).not.toContain("web");
    expect(stored).not.toContain("P0");
  });

  it("falls back to the default set when there is no storage at all", () => {
    // The SSR case. `localStorage` does not exist on the server, and a read
    // that threw there would take the whole board down rather than
    // rendering the default header.
    expect(readVisibleFilters(null)).toEqual(DEFAULT_VISIBLE_FILTERS);
    // A write with nowhere to write is a no-op, not a throw.
    expect(() => writeVisibleFilters(["area"], null)).not.toThrow();
  });

  it("falls back to the default set for anything unusable in storage", () => {
    // Three separate ways a stored value can be unreadable, all resolving to
    // the same thing. Removing the `JSON.parse` guard is the change this
    // catches — an exception during a render is a blank screen.
    expect(readVisibleFilters(fakeStorage())).toEqual(DEFAULT_VISIBLE_FILTERS);
    expect(readVisibleFilters(fakeStorage({ [VISIBLE_FILTERS_STORAGE_KEY]: "not json" }))).toEqual(
      DEFAULT_VISIBLE_FILTERS,
    );
    expect(
      readVisibleFilters(fakeStorage({ [VISIBLE_FILTERS_STORAGE_KEY]: JSON.stringify({}) })),
    ).toEqual(DEFAULT_VISIBLE_FILTERS);
    expect(
      readVisibleFilters(fakeStorage({ [VISIBLE_FILTERS_STORAGE_KEY]: JSON.stringify([1, 2]) })),
    ).toEqual(DEFAULT_VISIBLE_FILTERS);
  });

  it("honours an empty stored set rather than restoring the default over it", () => {
    // A reader who unticked everything meant it. Quietly putting eight
    // controls back is the interface disagreeing with them, and it is the
    // easy bug to write: treating empty as falsy.
    const storage = fakeStorage({ [VISIBLE_FILTERS_STORAGE_KEY]: JSON.stringify([]) });
    expect(readVisibleFilters(storage)).toEqual([]);
  });

  it("drops an axis this build does not have, keeping the rest", () => {
    // A preference written by a build with an axis that has since been
    // removed must not discard the whole preference.
    const storage = fakeStorage({
      [VISIBLE_FILTERS_STORAGE_KEY]: JSON.stringify(["area", "not-an-axis", "repo"]),
    });
    expect(readVisibleFilters(storage)).toEqual(["area", "repo"]);
  });

  it("survives a storage that throws on access", () => {
    // A browser with site data blocked HAS a `localStorage` property and
    // throws when it is touched, so a `typeof` check alone does not cover
    // this — the try/catch does.
    const hostile: VisibleFiltersStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readVisibleFilters(hostile)).toEqual(DEFAULT_VISIBLE_FILTERS);
    expect(() => writeVisibleFilters(["area"], hostile)).not.toThrow();
  });
});

describe("the visible set is ordered and bounded", () => {
  it("puts a set into header order however it was assembled", () => {
    // Two readers with the same axes visible see the same bar, rather than
    // a layout that depends on the order they happened to tick boxes in.
    expect(normaliseVisibleFilters(["repo", "area"])).toEqual(["area", "repo"]);
    // ...and a duplicate collapses rather than rendering the control twice.
    expect(normaliseVisibleFilters(["area", "area"])).toEqual(["area"]);
  });

  it("offers every filter axis except search", () => {
    // `search` is the bar's primary control and what the whole row is a
    // search landmark for — a picker entry that could empty that landmark is
    // worse than no entry. Every OTHER axis must be offerable, or an axis
    // that is off by default has no route into the header at all.
    const offered = FILTER_VISIBILITY_CHOICES.map((choice) => choice.param);
    expect(offered).not.toContain("search");
    expect(offered).toContain("level");
    expect(offered).toContain("project");
    expect(offered).toContain("area");
  });

  it("shows level by default and project only on request", () => {
    // `level` acts on every board whether or not anyone asked (its default
    // is `exclude(0)`), so a header with no level control would be hiding
    // rows for a reason nothing on screen explains. `project` is the tenth
    // control on an eight-control row and is reached far more often by
    // clicking a project card, so it waits to be asked for — which is what
    // makes the picker worth having at all.
    expect(isFilterVisible(DEFAULT_VISIBLE_FILTERS, "level")).toBe(true);
    expect(isFilterVisible(DEFAULT_VISIBLE_FILTERS, "project")).toBe(false);
  });
});

describe("an axis that is narrowing the board cannot be hidden", () => {
  it("refuses to hide a set axis, and does not clear the filter to allow it", () => {
    // Hiding it would leave the board filtered with no on-screen control to
    // undo it — the reader sees a short board, sees no filter, and has only
    // the back button. Clearing the filter instead would be worse: a control
    // that claims to change what the HEADER shows would change what the
    // BOARD shows.
    const filters: BoardFilters = { area: "web", level: defaultLevelFilter() };
    expect(canHide("area", filters)).toBe(false);
    const after = visibilityToggled(DEFAULT_VISIBLE_FILTERS, "area", false, filters);
    expect(after).toContain("area");
    // The filter itself is untouched — this function returns a visibility
    // set and has no business editing the query.
    expect(filters.area).toBe("web");
  });

  it("allows hiding an axis nothing is set on", () => {
    const filters: BoardFilters = { level: defaultLevelFilter() };
    expect(canHide("repo", filters)).toBe(true);
    expect(visibilityToggled(DEFAULT_VISIBLE_FILTERS, "repo", false, filters)).not.toContain(
      "repo",
    );
  });

  it("treats a DEFAULT level as not narrowing, so the level control can be hidden", () => {
    // `level` is never absent once a query is parsed — absent MEANS the
    // default — so a bare `=== undefined` test would make this axis
    // permanently un-hideable, which is the opposite of the rule.
    expect(canHide("level", { level: defaultLevelFilter() })).toBe(true);
    // ...but a level the reader chose IS narrowing, and locks the control on
    // screen exactly like any other set axis. `include:2` rather than
    // `include:1`, which IS the default and so is covered by the assertion
    // above — asserting on it here would test the opposite of this case.
    expect(canHide("level", { level: { mode: "include", levels: [2] } })).toBe(false);
  });

  it("turning an axis on always works, whatever the filters say", () => {
    const shown = visibilityToggled([], "project", true, { project: "proj-1" });
    expect(shown).toContain("project");
  });
});

describe("the store React subscribes to", () => {
  it("gives the SERVER the default set, whatever a browser might hold", () => {
    // The SSR snapshot is what makes the first client render agree with the
    // server render by construction. Returning the stored value here is the
    // change this catches — it would hydrate-mismatch for every reader who
    // had chosen anything, and React resolves that by discarding the client
    // tree.
    expect(visibleFiltersServerSnapshot()).toEqual(DEFAULT_VISIBLE_FILTERS);
  });

  it("returns a STABLE snapshot until something changes", () => {
    // `useSyncExternalStore` compares snapshots by reference and re-renders
    // whenever one differs. Parsing storage afresh on every call returns a
    // new array each time, which is an infinite render loop rather than a
    // slow one — so identity, not just equality, is the assertion.
    resetVisibleFiltersCache();
    const first = visibleFiltersSnapshot();
    expect(visibleFiltersSnapshot()).toBe(first);
  });

  it("notifies subscribers, and the new value is readable when they run", () => {
    // The cache has to be replaced BEFORE the listeners fire, or a component
    // re-rendered by this notification reads the value it just replaced and
    // renders one change behind.
    resetVisibleFiltersCache();
    let seen: readonly string[] | null = null;
    const unsubscribe = subscribeToVisibleFilters(() => {
      seen = visibleFiltersSnapshot();
    });
    setVisibleFilters(["area", "repo"]);
    expect(seen).toEqual(["area", "repo"]);
    expect(visibleFiltersSnapshot()).toEqual(["area", "repo"]);
    unsubscribe();
    // ...and an unsubscribed listener stops being called, or a component
    // that has unmounted keeps being told about changes.
    setVisibleFilters(["area"]);
    expect(seen).toEqual(["area", "repo"]);
    resetVisibleFiltersCache();
  });
});
