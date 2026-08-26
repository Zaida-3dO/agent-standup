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
import { DEFAULT_VISIBLE_FILTERS, FILTER_VISIBILITY_CHOICES } from "@/lib/board/visible-filters";
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
    // The bar renders only the axes a reader has turned on, so the default
    // set is what "the bar" means in these tests. Overridable, because the
    // tests below that are ABOUT the picker need to vary it.
    visibleFilters: DEFAULT_VISIBLE_FILTERS,
    onVisibilityChange: () => {},
    ...overrides,
  }) as ReactElement;
}

describe("every filter the service accepts is reachable from the bar", () => {
  it("renders a control for each of the nine axes visible by default", () => {
    // The acceptance criterion, as a rendering assertion: the service's
    // filters were finished and unreachable, and a missing control here is
    // that defect returning for one axis.
    //
    // Nine and not ten: `project` is the one axis the header does not show
    // until a reader turns it on, which is what the picker exists for. It
    // has its own assertion below rather than being quietly absent from
    // this list.
    const tree = bar();
    for (const id of [
      "board-filter-area",
      "board-filter-repo",
      "board-filter-assignee",
      "board-filter-actor",
      "board-filter-priority",
      "board-filter-state",
      "board-filter-kind",
      // The level axis is a chip group, not a select — its mode button is
      // the control that must exist for the axis to be operable at all.
      "board-filter-level-mode",
    ]) {
      expect(byId(tree, id), `${id} is missing from the filter bar`).toBeDefined();
    }
    expect(byId(tree, "board-search")).toBeDefined();
    // Every axis the picker offers is reachable — the picker is the only
    // way to reach one that is off by default, so a picker missing an entry
    // is an axis with no route to the header at all.
    for (const choice of FILTER_VISIBILITY_CHOICES) {
      expect(
        byId(bar({ pickerOpen: true }), `board-show-${choice.param}`),
        `${choice.param} has no checkbox in the More-filters picker`,
      ).toBeDefined();
    }
  });

  it("renders an axis only when it is in the visible set", () => {
    // The picker's whole contract in one assertion. The single-character
    // change this catches: dropping the `shows(...)` guard on an axis, which
    // would put every control back in the header and make the picker a
    // decoration that silently does nothing.
    const hidden = bar({ visibleFilters: DEFAULT_VISIBLE_FILTERS.filter((p) => p !== "repo") });
    expect(byId(hidden, "board-filter-repo")).toBeUndefined();
    // ...and the axes that ARE in the set still render, so the assertion
    // above is about the one axis removed rather than about a bar that
    // rendered nothing at all.
    expect(byId(hidden, "board-filter-area")).toBeDefined();

    const shown = bar({ visibleFilters: [...DEFAULT_VISIBLE_FILTERS, "project"] });
    expect(byId(shown, "board-filter-project")).toBeDefined();
  });

  // The trust axis. Off by default like `project` — see
  // `DEFAULT_VISIBLE_FILTERS` for why — so the thing worth proving is that
  // it is REACHABLE: turning it on renders a working control, and choosing
  // a value narrows the board.
  it("renders a trust control once it is turned on, so trust can be asked for", () => {
    const off = bar();
    expect(byId(off, "board-filter-trust")).toBeUndefined();
    const on = bar({ visibleFilters: [...DEFAULT_VISIBLE_FILTERS, "trust"] });
    const select = byId(on, "board-filter-trust");
    expect(select).toBeDefined();
    // Every position is offered, plus the "Any" that widens it again.
    const values = [...walk(select!.children as never)]
      .filter((el) => el.type === "option")
      .map((el) => (el.props as { value?: unknown }).value);
    expect(values).toEqual(["", "trusted", "unverified", "verified"]);
  });

  it("reports the chosen trust value on the axis it was chosen for", () => {
    // The single-character change this catches: passing a different key to
    // `onFilterChange`, which would silently narrow some other axis.
    const changes: Array<[string, unknown]> = [];
    const tree = bar({
      visibleFilters: [...DEFAULT_VISIBLE_FILTERS, "trust"],
      onFilterChange: (key: string, value: unknown) => changes.push([key, value]),
    });
    const select = byId(tree, "board-filter-trust") as unknown as {
      onChange: (event: { target: { value: string } }) => void;
    };
    select.onChange({ target: { value: "unverified" } });
    expect(changes).toEqual([["trust", "unverified"]]);
    // …and choosing "Any" clears it rather than filtering on an empty string.
    select.onChange({ target: { value: "" } });
    expect(changes[1]).toEqual(["trust", undefined]);
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

// The narrow-width axes disclosure (row 74ef86fb-9da8-4ab1-9b63-9eb84bd43ee6,
// blocker ccce0635-b2af-4c18-990b-016edeca8184). What this CAN and cannot
// prove is worth being explicit about: this harness has no DOM and no CSS
// engine (vitest.config.ts: environment: "node"), so it cannot exercise the
// CSS sibling-selector toggle or confirm the block actually paints in a
// browser -- that is exactly the class of defect the details-element attempt
// had, invisible to a static tree and caught only by a real screenshot (see
// 1d7ebff1-faf7-4772-a17b-14f4e80fbbca, filed separately for a real-browser
// check this repo has no precedent for inside tests/).
//
// What it CAN prove, and does: the exact two attributes whose presence was
// the round-2 defect. aria-hidden and a negative tabIndex are structural
// facts on the returned element -- this is precisely the shape of assertion
// byId exists for, and it would have failed against the code this review
// bounced.
describe("the axes disclosure toggle (narrow-width collapse)", () => {
  it("the checkbox carries no aria-hidden and no negative tabIndex -- both remove it from the keyboard path", () => {
    const toggle = byId(bar(), "board-axes-toggle");
    expect(toggle?.["aria-hidden"]).toBeUndefined();
    expect(toggle?.tabIndex).not.toBe(-1);
  });

  it("the checkbox starts unchecked (collapsed is the narrow-width default)", () => {
    // defaultChecked, not checked -- this control is deliberately uncontrolled
    // (see BoardFilterBar.module.css's header on this block), so the
    // render-time prop is the one fact a hook-free harness can observe about
    // its starting state.
    expect(byId(bar(), "board-axes-toggle")?.defaultChecked).toBe(false);
  });

  it("the label names the checkbox by id, and starts with aria-expanded matching the unchecked default", () => {
    const toggle = byId(bar(), "board-axes-toggle");
    const labels = tags(bar(), "label").filter(
      (el) => (el.props as { htmlFor?: string }).htmlFor === "board-axes-toggle",
    );
    expect(labels).toHaveLength(1);
    const label = labels[0]!.props as { "aria-expanded"?: boolean };
    // aria-expanded lives on the LABEL, not the checkbox -- the checkbox ARIA
    // role does not support it the way button does, and the label is the
    // visible control a keyboard/AT user actually operates. Matches
    // defaultChecked above by construction; if the two are ever set from
    // different literals this fails without needing a browser to catch the
    // drift.
    expect(label["aria-expanded"]).toBe(toggle?.defaultChecked);
  });

  it("gives the label a role that actually supports aria-expanded, and points it at the panel it discloses", () => {
    // Row cd36e9fd-25e1-47f8-980c-7c0ea9a178a6: a plain <label> has no ARIA
    // role of its own (maps to `generic`), which does not support
    // `aria-expanded` either -- moving the attribute off the checkbox and
    // onto an unstyled label just moved it to a second role that drops it,
    // so it was written and kept in sync but never reached assistive tech.
    // `role="button"` is the role aria-expanded IS defined for. The single-
    // character change this catches: reverting the role (or the id it
    // points at) back off the label.
    const labels = tags(bar(), "label").filter(
      (el) => (el.props as { htmlFor?: string }).htmlFor === "board-axes-toggle",
    );
    const label = labels[0]!.props as { role?: string; "aria-controls"?: string };
    expect(label.role).toBe("button");
    expect(label["aria-controls"]).toBe("board-axes-panel");

    const panel = byId(bar(), "board-axes-panel");
    expect(panel, "no element carries the id aria-controls points at").toBeDefined();
  });

  it("says how many filters are active even while collapsed, so a narrowed board is not silently unexplained", () => {
    const labels = tags(bar({ query: parseBoardQuery("area=web&priority=P0") }), "label").filter(
      (el) => (el.props as { htmlFor?: string }).htmlFor === "board-axes-toggle",
    );
    // The count renders as an interpolated expression inside the summary
    // span, so its `children` prop is an ARRAY of two strings ("Filters" and
    // the computed suffix) rather than one string `walk` would surface on
    // its own -- `walk` only recurses into element children, so a bare
    // string in that array is otherwise never visited. Reading each span's
    // `children` prop directly and joining any array entries is what
    // actually finds the rendered text here.
    const spans = tags(labels[0]!, "span");
    const texts = spans.flatMap((el) => {
      const children = (el.props as { children?: unknown }).children;
      if (typeof children === "string") return [children];
      if (Array.isArray(children)) {
        return [children.filter((c) => typeof c === "string").join("")];
      }
      return [];
    });
    expect(texts.some((t) => t.includes("2 active"))).toBe(true);
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
    // Asserted against the CLEAR BUTTON's own rendered children rather than
    // by scanning the whole serialised tree for the substring "filters".
    // That scan read as a test of the pluralisation and was really a test of
    // every prop name in the bar — it went red the moment an unrelated
    // component was given a prop called `filters`, and it would equally have
    // passed a broken pluralisation had any other node happened to contain
    // the word. This looks at the text the reader actually sees.
    // The button's text with its parts CONCATENATED. JSX renders
    // `filter{n === 1 ? "" : "s"}` as two adjacent children, so the rendered
    // word only exists once they are joined — a check over the serialised
    // children would never find "filters" however many filters were active.
    const clearText = (query: BoardQuery): string => {
      for (const el of walk(expand(bar({ query })) as ReactElement)) {
        if (el.type !== "button") continue;
        const props = el.props as { className?: unknown };
        if (typeof props.className !== "string" || !props.className.includes("clear")) continue;
        const parts: string[] = [];
        for (const inner of walk(el)) {
          const children = (inner.props as { children?: unknown }).children;
          for (const child of Array.isArray(children) ? children : [children]) {
            if (typeof child === "string" || typeof child === "number") parts.push(String(child));
          }
        }
        return parts.join("");
      }
      return "";
    };
    expect(clearText(parseBoardQuery("area=web"))).toContain("filter");
    expect(clearText(parseBoardQuery("area=web"))).not.toContain("filters");
    // The plural half, which the original never asserted — without it, a
    // hardcoded "filter" with the pluralisation deleted would still pass.
    expect(clearText(parseBoardQuery("area=web&repo=api"))).toContain("filters");
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
