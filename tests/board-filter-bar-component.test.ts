// The filter bar and the saved-view chips as element trees — MILESTONES.md
// #75.
//
// Called as plain functions rather than rendered, which is what this repo's
// `environment: "node"` harness allows and is why these components are
// hook-free — see `tests/helpers/react-element.ts`.
import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { BoardFilterBarView } from "@/components/board/BoardFilterBarView";
import { SavedViewsView } from "@/components/board/SavedViewsView";
import { emptyBoardQuery, parseBoardQuery, type BoardQuery } from "@/lib/board/filters";
import { BoardColumn } from "@/components/board/BoardColumn";
import { EmptyState } from "@/components/states/EmptyState";
import { walk } from "./helpers/react-element";

/**
 * The tree with every hook-free child component invoked, so the assertions
 * below see the HOST elements — the real `<select>`, not the `AxisSelect`
 * element that produces it.
 *
 * `walk` deliberately does not do this: a React element for a component is
 * an unrendered description, and calling it is only safe because every
 * component in this directory is hook-free by design. That is the same
 * property the whole DOM-free harness rests on, so exercising it here is
 * consistent rather than a special case — and it is what stops these tests
 * asserting against props a caller passed rather than markup that rendered.
 */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== "object" || node === null) return node;
  const el = node as ReactElement;
  if (!("type" in el) || !("props" in el)) return node;
  const props = el.props as Record<string, unknown>;
  if (typeof el.type === "function") {
    return expand((el.type as (p: unknown) => unknown)(props));
  }
  if (props.children === undefined) return el;
  return { ...el, props: { ...props, children: expand(props.children) } };
}

/** Every element in a fully expanded tree with the given tag. */
function tags(tree: ReactElement, tag: string): ReactElement[] {
  return [...walk(expand(tree) as ReactElement)].filter((el) => el.type === tag);
}

/**
 * The props of the HOST element carrying this `id` — a `select`, `input` or
 * `button`, never the component that produced it.
 *
 * The distinction matters: `AxisSelect` takes an `id` prop of its own and
 * passes it down, so a naive "first element with this id" walk finds the
 * component wrapper, whose props are the ones the *caller* passed rather
 * than the ones actually rendered. Asserting against those would pass while
 * the real `<select>` had none of them.
 */
function byId(tree: ReactElement, id: string): Record<string, unknown> | undefined {
  for (const el of walk(expand(tree) as ReactElement)) {
    if (typeof el.type !== "string") continue;
    const props = el.props as Record<string, unknown>;
    if (props.id === id) return props;
  }
  return undefined;
}

function bar(overrides: Partial<Parameters<typeof BoardFilterBarView>[0]> = {}): ReactElement {
  return BoardFilterBarView({
    query: emptyBoardQuery(),
    onFilterChange: () => {},
    onSortChange: () => {},
    onToggleDirection: () => {},
    onClearFilters: () => {},
    searchDraft: "",
    onSearchDraftChange: () => {},
    ...overrides,
  }) as ReactElement;
}

describe("every filter the service accepts is reachable from the bar", () => {
  it("renders a control for each of the eight axes", () => {
    // The acceptance criterion, as a rendering assertion: the service's
    // filters were finished and unreachable, and a missing control here is
    // that defect returning for one axis.
    const tree = bar();
    for (const id of [
      "board-filter-area",
      "board-filter-repo",
      "board-filter-assignee",
      "board-filter-actor",
      "board-filter-priority",
      "board-filter-state",
      "board-filter-kind",
    ]) {
      expect(byId(tree, id), `${id} is missing from the filter bar`).toBeDefined();
    }
    expect(byId(tree, "board-search")).toBeDefined();
  });

  it("gives every select an 'Any' option, so a narrowed axis can be widened again", () => {
    // Without it, a reader who filters by area can never clear that filter
    // from the control that set it — the most common way a filter bar traps
    // someone.
    const tree = bar();
    for (const select of tags(tree, "select")) {
      const id = (select.props as { id?: string }).id;
      if (id === "board-sort") continue;
      const options = tags(select, "option");
      expect(options[0]?.props).toMatchObject({ value: "" });
    }
  });

  it("labels every select, rather than relying on a placeholder option", () => {
    // A placeholder vanishes the moment a value is chosen, leaving an
    // unnamed control for a screen-reader user.
    const tree = bar();
    const labelledFor = new Set(
      tags(tree, "label").map((el) => (el.props as { htmlFor?: string }).htmlFor),
    );
    for (const select of tags(tree, "select")) {
      expect(labelledFor).toContain((select.props as { id?: string }).id);
    }
  });
});

describe("the bar reflects the query it is given", () => {
  it("shows each axis's current value", () => {
    const query = parseBoardQuery("area=web&repo=api&priority=P0&state=blocked&kind=task");
    const tree = bar({ query });
    expect(byId(tree, "board-filter-area")?.value).toBe("web");
    expect(byId(tree, "board-filter-repo")?.value).toBe("api");
    expect(byId(tree, "board-filter-priority")?.value).toBe("P0");
    expect(byId(tree, "board-filter-state")?.value).toBe("blocked");
    expect(byId(tree, "board-filter-kind")?.value).toBe("task");
  });

  it("renders an unset axis as the empty value, not as undefined", () => {
    // `value={undefined}` makes React treat a select as uncontrolled and
    // warn — and the control then stops following the URL.
    expect(byId(bar(), "board-filter-area")?.value).toBe("");
  });

  it("marks a narrowed axis, so the strip can be scanned for what is filtered", () => {
    expect(byId(bar({ query: parseBoardQuery("area=web") }), "board-filter-area")).toMatchObject({
      "data-filtered": "true",
    });
    expect(byId(bar(), "board-filter-area")?.["data-filtered"]).toBeUndefined();
  });
});

describe("the sort control", () => {
  it("offers all four keys", () => {
    const sort = byId(bar(), "board-sort");
    expect(sort).toBeDefined();
    const options = tags(
      createElement("div", null, (sort as { children?: unknown }).children as never),
      "option",
    );
    expect(options.map((o) => (o.props as { value?: string }).value)).toEqual([
      "priority",
      "name",
      "created",
      "updated",
    ]);
  });

  it("says the direction in words, not only as an arrow", () => {
    // An arrow glyph carries nothing to a screen reader, and WCAG 1.4.1 is
    // exactly about a single visual channel carrying the meaning. Dropping
    // the word from the label leaves the control unreadable.
    const asc = bar({ query: { filters: {}, sort: "priority", direction: "asc" } as BoardQuery });
    const ascButton = [...walk(asc)].find(
      (el) => (el.props as { "data-direction"?: string })["data-direction"] === "asc",
    );
    expect((ascButton?.props as { "aria-label"?: string })["aria-label"]).toMatch(/ascending/i);

    const desc = bar({ query: { filters: {}, sort: "priority", direction: "desc" } as BoardQuery });
    const descButton = [...walk(desc)].find(
      (el) => (el.props as { "data-direction"?: string })["data-direction"] === "desc",
    );
    expect((descButton?.props as { "aria-label"?: string })["aria-label"]).toMatch(/descending/i);
  });
});

describe("the clear control", () => {
  it("is absent when nothing is narrowed", () => {
    // A permanently visible control that does nothing most of the time
    // teaches a reader to ignore it.
    const text = JSON.stringify(bar());
    expect(text).not.toMatch(/Clear \d/);
  });

  it("says how many filters it will undo", () => {
    expect(JSON.stringify(bar({ query: parseBoardQuery("area=web") }))).toContain("Clear ");
    const three = JSON.stringify(bar({ query: parseBoardQuery("area=web&repo=api&priority=P0") }));
    expect(three).toContain("3");
  });

  it("counts one filter as singular", () => {
    const one = JSON.stringify(bar({ query: parseBoardQuery("area=web") }));
    expect(one).toContain("filter");
    expect(one).not.toContain("filters");
  });
});

describe("the search box", () => {
  it("describes what it matches rather than promising a ranked search", () => {
    // The box is a case-insensitive substring match. A label that implied
    // relevance ordering would mislead about the one thing this build does
    // not do.
    const props = byId(bar(), "board-search");
    expect(props?.["aria-label"]).toMatch(/title or body/i);
    expect(String(props?.title)).toMatch(/not a ranked search/i);
  });

  it("shows the draft it is given, not the URL's value", () => {
    // The two differ while a reader is mid-word — that is what the debounce
    // is for, and reading the URL here would delete characters as they typed.
    const props = byId(
      bar({ query: parseBoardQuery("search=old"), searchDraft: "new" }),
      "board-search",
    );
    expect(props?.value).toBe("new");
  });
});

describe("the saved-view chips", () => {
  function views(overrides: Partial<Parameters<typeof SavedViewsView>[0]> = {}): ReactElement {
    return SavedViewsView({
      views: [{ name: "My P0s", query: "priority=P0", pinned: true }],
      currentQuery: "",
      onApply: () => {},
      onDelete: () => {},
      nameDraft: "",
      onNameDraftChange: () => {},
      onSave: () => {},
      saveProblem: null,
      ...overrides,
    }) as ReactElement;
  }

  it("marks the chip whose query matches the board", () => {
    const active = [...walk(views({ currentQuery: "priority=P0" }))].some(
      (el) => (el.props as { "aria-current"?: string })["aria-current"] === "true",
    );
    expect(active).toBe(true);
  });

  it("marks nothing when the board matches no saved view", () => {
    const active = [...walk(views({ currentQuery: "area=web" }))].some(
      (el) => (el.props as { "aria-current"?: string })["aria-current"] === "true",
    );
    expect(active).toBe(false);
  });

  it("names the view in the delete control's accessible name", () => {
    // "Delete" alone, repeated once per chip, is a row of identical controls
    // to anyone not reading the visual layout.
    const labels = [...walk(views())]
      .map((el) => (el.props as { "aria-label"?: string })["aria-label"])
      .filter((l): l is string => typeof l === "string");
    expect(labels.some((l) => l.includes("My P0s"))).toBe(true);
  });

  it("says why saving is refused instead of only disabling the control", () => {
    const tree = views({ saveProblem: "Give the view a name before saving it." });
    expect(JSON.stringify(tree)).toContain("Give the view a name");
  });
});

describe("a filtered-to-nothing column", () => {
  // The acceptance criterion is that this uses the EXISTING shared state
  // component rather than a new one. So the assertion is an identity check
  // on the component function, not a check on the words it renders: a
  // board-local copy that produced identical markup would pass a text
  // assertion and fail the criterion.
  it("renders the shared EmptyState, not a board-local copy of it", () => {
    const column = BoardColumn({
      column: "backlog",
      // Nothing shown, but rows exist and a filter is on — the exact
      // `filtered` case `emptinessOf` decides. `withheld: false` matters:
      // `withheld` outranks `filtered`, because a column that was not read
      // cannot know whether the filter would have excluded its contents.
      section: { entries: [], total: 12, nextCursor: null, withheld: false },
      personId: null,
      now: 0,
      filtered: true,
      onClearFilter: () => {},
    }) as ReactElement;

    const empties = [...walk(column)].filter((el) => el.type === EmptyState);
    expect(empties).toHaveLength(1);
    expect((empties[0]!.props as { kind?: string }).kind).toBe("filtered");
    // The clear control is what makes this the one empty state a reader can
    // act on — passing the state without the handler renders a dead end.
    expect((empties[0]!.props as { onClearFilter?: unknown }).onClearFilter).toBeTypeOf("function");
  });

  it("says 'nothing here' rather than blaming a filter when no filter is on", () => {
    // Reversing this is the #123 defect from the other side: a reader told
    // to clear a filter they never set.
    const column = BoardColumn({
      column: "backlog",
      section: { entries: [], total: 0, nextCursor: null, withheld: false },
      personId: null,
      now: 0,
      filtered: false,
    }) as ReactElement;
    const empties = [...walk(column)].filter((el) => el.type === EmptyState);
    expect((empties[0]!.props as { kind?: string }).kind).toBe("empty");
  });
});
