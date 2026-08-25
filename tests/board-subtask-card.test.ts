// The subtask badge and the disclosure that expands a card in place — the
// rendering half of what `BoardEntry.subtasks` is for.
//
// Hook-free components called as plain functions, per this repo's harness
// (`tests/helpers/react-element.ts`). The WIRING — that pressing the control
// actually reaches the board's handler and that a fetch is issued — is
// asserted in tests/board-react-wiring.test.ts, which mounts real React.
// Both halves are needed and neither substitutes for the other: a badge that
// renders perfectly from a prop nothing ever passes is the "the units are
// tested, the composition isn't" failure.
import { describe, expect, it } from "vitest";
import { ItemCard, subtaskSummary } from "@/components/board/ItemCard";
import { BoardColumn } from "@/components/board/BoardColumn";
import { findAllByType, walk } from "./helpers/react-element";
import type { BoardEntry, BoardItem, SubtaskRollup } from "@/lib/board/types";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-a",
    title: "A card",
    headline: null,
    kind: "task",
    state: "on_deck",
    priority: "P2",
    area: "web",
    repo: null,
    blockedOnPersonId: null,
    blockedOnType: null,
    blockedReason: null,
    pauseReason: null,
    ...overrides,
  };
}

function entry(subtasks: SubtaskRollup | null, overrides: Partial<BoardItem> = {}): BoardEntry {
  return { item: item(overrides), column: "backlog", assignments: [], trust: null, subtasks };
}

/** Every string rendered anywhere in a tree, joined — for "does the card say this at all". */
function textOf(node: ReturnType<typeof ItemCard>): string {
  const parts: string[] = [];
  for (const element of walk(node)) {
    const children = (element.props as { children?: unknown }).children;
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

/** The disclosure control, or undefined when the card rendered none. */
function toggleOf(node: ReturnType<typeof ItemCard>) {
  return findAllByType(node, "button").find(
    (element) => (element.props as { "aria-expanded"?: unknown })["aria-expanded"] !== undefined,
  );
}

describe("the badge's words", () => {
  it("says how many, and how many are done", () => {
    expect(subtaskSummary({ total: 3, done: 2 })).toBe("3 subtasks · 2 done");
  });

  it("uses the singular for exactly one", () => {
    // "1 subtasks" is the kind of thing nobody notices in review and
    // everybody notices on screen.
    expect(subtaskSummary({ total: 1, done: 0 })).toBe("1 subtask");
    expect(subtaskSummary({ total: 1, done: 1 })).toBe("1 subtask · 1 done");
  });

  it("omits the done clause entirely when nothing is done", () => {
    // Rather than "3 subtasks · 0 done", which reads as a progress report on
    // work nobody has started — noise on every freshly broken-down card.
    expect(subtaskSummary({ total: 3, done: 0 })).toBe("3 subtasks");
  });
});

describe("a card states what it holds", () => {
  it("renders the badge when there are subtasks beneath it", () => {
    const node = ItemCard({
      entry: entry({ total: 3, done: 1 }),
      needsYou: false,
      now: 0,
      onToggleExpanded: () => {},
    });
    expect(textOf(node)).toContain("3 subtasks · 1 done");
  });

  it("renders no badge and no control for a card with nothing beneath it", () => {
    // `subtasks: null` is "nothing under this card", which must not render
    // as "0 subtasks" — a sentence about work that does not exist.
    const node = ItemCard({
      entry: entry(null),
      needsYou: false,
      now: 0,
      onToggleExpanded: () => {},
    });
    expect(textOf(node)).not.toContain("subtask");
    expect(toggleOf(node)).toBeUndefined();
  });

  it("states the count without offering a control when nothing is wired to it", () => {
    // The same rule `onDragStart` follows: a card that renders a button
    // nobody listens to offers a gesture that does nothing.
    const node = ItemCard({ entry: entry({ total: 2, done: 0 }), needsYou: false, now: 0 });
    expect(textOf(node)).toContain("2 subtasks");
    expect(toggleOf(node)).toBeUndefined();
  });
});

describe("the disclosure control", () => {
  it("reports its state through aria-expanded, both ways", () => {
    // Without this the control is announced identically open and closed, so
    // a screen-reader user cannot tell whether pressing it did anything.
    const collapsed = ItemCard({
      entry: entry({ total: 2, done: 0 }),
      needsYou: false,
      now: 0,
      onToggleExpanded: () => {},
    });
    expect((toggleOf(collapsed)?.props as { "aria-expanded": boolean })["aria-expanded"]).toBe(
      false,
    );

    const expanded = ItemCard({
      entry: entry({ total: 2, done: 0 }),
      needsYou: false,
      now: 0,
      expanded: true,
      onToggleExpanded: () => {},
      subtaskEntries: [],
    });
    expect((toggleOf(expanded)?.props as { "aria-expanded": boolean })["aria-expanded"]).toBe(true);
  });

  it("is a real button, so it is reachable and operable by keyboard", () => {
    // A div with an onClick renders the same and is unreachable by tab and
    // unactivatable by Enter or Space.
    const node = ItemCard({
      entry: entry({ total: 2, done: 0 }),
      needsYou: false,
      now: 0,
      onToggleExpanded: () => {},
    });
    expect(toggleOf(node)?.type).toBe("button");
    expect((toggleOf(node)?.props as { type: string }).type).toBe("button");
  });

  it("hands its own item id to the handler", () => {
    // A control that toggled the wrong card would look like it worked.
    const toggled: string[] = [];
    const node = ItemCard({
      entry: entry({ total: 2, done: 0 }, { id: "item-xyz" }),
      needsYou: false,
      now: 0,
      onToggleExpanded: (id) => toggled.push(id),
    });
    const onClick = (toggleOf(node)?.props as { onClick: (e: unknown) => void }).onClick;
    onClick({ stopPropagation: () => {} });
    expect(toggled).toEqual(["item-xyz"]);
  });

  it("stops the press from also starting a drag", () => {
    // The card is a drag source and the title is a link. Without this, a
    // press on the control picks the card up instead of expanding it.
    let stopped = 0;
    const node = ItemCard({
      entry: entry({ total: 2, done: 0 }),
      needsYou: false,
      now: 0,
      onToggleExpanded: () => {},
    });
    const props = toggleOf(node)?.props as {
      onClick: (e: unknown) => void;
      onPointerDown: (e: unknown) => void;
    };
    props.onClick({ stopPropagation: () => stopped++ });
    props.onPointerDown({ stopPropagation: () => stopped++ });
    expect(stopped).toBe(2);
  });
});

describe("what an expanded card shows", () => {
  const children: readonly BoardEntry[] = [
    entry(null, { id: "child-1", title: "First subtask", state: "executing" }),
    entry(null, { id: "child-2", title: "Second subtask", state: "merged" }),
  ];

  it("lists its subtasks in place, beneath itself", () => {
    const node = ItemCard({
      entry: entry({ total: 2, done: 1 }),
      needsYou: false,
      now: 0,
      expanded: true,
      onToggleExpanded: () => {},
      subtaskEntries: children,
    });
    const text = textOf(node);
    expect(text).toContain("First subtask");
    expect(text).toContain("Second subtask");
    // Nested INSIDE this card's own <li>, which is what "in place" means —
    // a flat sibling list would be the peer-cards problem one level in.
    expect(findAllByType(node, "li").length).toBeGreaterThan(children.length);
  });

  it("shows nothing of the list while it is collapsed", () => {
    // Otherwise a collapsed board pays to render every subtask of every card
    // nobody opened.
    const node = ItemCard({
      entry: entry({ total: 2, done: 1 }),
      needsYou: false,
      now: 0,
      expanded: false,
      onToggleExpanded: () => {},
      subtaskEntries: children,
    });
    expect(textOf(node)).not.toContain("First subtask");
  });

  it("distinguishes a fetch in flight from a fetch that returned nothing", () => {
    // The load-bearing case: `undefined` (not fetched) and `[]` (fetched,
    // empty) must not render identically, or a slow response looks like an
    // answer.
    const loading = ItemCard({
      entry: entry({ total: 2, done: 0 }),
      needsYou: false,
      now: 0,
      expanded: true,
      onToggleExpanded: () => {},
      childrenLoading: true,
    });
    expect(textOf(loading)).toContain("Loading subtasks");

    const arrivedEmpty = ItemCard({
      entry: entry({ total: 2, done: 0 }),
      needsYou: false,
      now: 0,
      expanded: true,
      onToggleExpanded: () => {},
      subtaskEntries: [],
    });
    expect(textOf(arrivedEmpty)).not.toContain("Loading subtasks");
  });

  it("shows why the subtasks could not be loaded, rather than an empty gap", () => {
    const node = ItemCard({
      entry: entry({ total: 2, done: 0 }),
      needsYou: false,
      now: 0,
      expanded: true,
      onToggleExpanded: () => {},
      childrenError: "Could not load subtasks (GET /api/board returned 500).",
    });
    expect(textOf(node)).toContain("Could not load subtasks");
    // ...and does NOT also claim to be loading, which would be two
    // contradictory statements at once.
    expect(textOf(node)).not.toContain("Loading subtasks");
  });
});

describe("the column passes the disclosure state down to the right card", () => {
  // The composition this file is really about: `BoardColumn` unpacks the
  // board's id-keyed maps into per-card props, and getting that wrong is
  // invisible to every assertion above — each card would still render
  // perfectly from whatever it was handed.
  const entries: readonly BoardEntry[] = [
    entry({ total: 2, done: 0 }, { id: "open-card", title: "Open" }),
    entry({ total: 5, done: 5 }, { id: "shut-card", title: "Shut" }),
  ];

  function columnTree(expandedId: string) {
    return BoardColumn({
      column: "backlog",
      section: { entries, total: entries.length, nextCursor: null, withheld: false },
      personId: null,
      now: 0,
      expansion: {
        expandedIds: new Set([expandedId]),
        onToggle: () => {},
        childrenByParent: new Map([
          ["open-card", [entry(null, { id: "kid", title: "Only under Open" })]],
        ]),
        loadingIds: new Set<string>(),
        errorsByParent: new Map<string, string>(),
      },
    });
  }

  it("expands only the card whose id is in the expanded set", () => {
    const cards = findAllByType(columnTree("open-card"), ItemCard);
    expect(cards).toHaveLength(2);
    const byId = new Map(
      cards.map((card) => [
        (card.props as { entry: BoardEntry }).entry.item.id,
        card.props as { expanded?: boolean },
      ]),
    );
    expect(byId.get("open-card")?.expanded).toBe(true);
    expect(byId.get("shut-card")?.expanded).toBe(false);
  });

  it("gives each card its OWN children, not another card's", () => {
    // A lookup keyed on the wrong id — or a single shared list — would put
    // one card's subtasks under another, which every per-card assertion
    // above would happily render.
    const cards = findAllByType(columnTree("open-card"), ItemCard);
    const byId = new Map(
      cards.map((card) => [
        (card.props as { entry: BoardEntry }).entry.item.id,
        card.props as { subtaskEntries?: readonly BoardEntry[] },
      ]),
    );
    expect(byId.get("open-card")?.subtaskEntries?.map((child) => child.item.id)).toEqual(["kid"]);
    expect(byId.get("shut-card")?.subtaskEntries).toBeUndefined();
  });

  it("leaves every card collapsed when no expansion is wired at all", () => {
    // The board without this feature: no control, no state, nothing changed.
    const tree = BoardColumn({
      column: "backlog",
      section: { entries, total: entries.length, nextCursor: null, withheld: false },
      personId: null,
      now: 0,
    });
    for (const card of findAllByType(tree, ItemCard)) {
      const props = card.props as { expanded?: boolean; onToggleExpanded?: unknown };
      expect(props.expanded).toBeUndefined();
      expect(props.onToggleExpanded).toBeUndefined();
    }
  });
});
