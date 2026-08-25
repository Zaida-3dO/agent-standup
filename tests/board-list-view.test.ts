// The list view — MILESTONES.md T6 §3, both the derivations
// (`@/lib/board/list`) and the component that renders them.
//
// Hook-free and prop-driven, so the component is called directly as a
// function and its returned element tree inspected — the same technique
// `tests/board-view-component.test.ts` uses, and for the same reason: this
// repo's harness runs `environment: "node"` with no DOM.
//
// The single-character source change each assertion protects against is
// named in its comment.
import { describe, expect, it } from "vitest";
import { ListView } from "@/components/board/ListView";
import { LayoutToggle } from "@/components/board/LayoutToggle";
import { StateChip } from "@/components/chips/StateChip";
import { PriorityChip } from "@/components/chips/PriorityChip";
import { EmptyState } from "@/components/states/EmptyState";
import { ErrorState } from "@/components/states/ErrorState";
import { LoadingState } from "@/components/states/LoadingState";
import { listEntries, listSections, listShown, listTotal, hasMore } from "@/lib/board/list";
import { emptyBoard } from "@/lib/board/view";
import { parseBoardQuery } from "@/lib/board/filters";
import type { Board, BoardColumnId, BoardEntry, BoardItem } from "@/lib/board/types";
import { boardOf, section } from "./helpers/board-sections";
import { findAllByType, walk } from "./helpers/react-element";
import type { ReactNode } from "react";
import Link from "next/link";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-1",
    title: "An item",
    headline: null,
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: "web",
    blockedOnPersonId: null,
    blockedOnType: null,
    blockedReason: null,
    pauseReason: null,
    ...overrides,
  };
}

function entry(
  column: BoardColumnId,
  overrides: Partial<BoardItem> = {},
  extra: Partial<Omit<BoardEntry, "item" | "column">> = {},
): BoardEntry {
  return { item: item(overrides), column, assignments: [], trust: null, ...extra };
}

/**
 * One prop off an element, typed.
 *
 * `ReactElement["props"]` is `unknown` under this repo's React types, so
 * every read needs a cast. Doing it here once keeps the assertions below
 * about the component rather than about TypeScript.
 */
function propOf<T = unknown>(el: { props: unknown } | undefined, name: string): T | undefined {
  return (el?.props as Record<string, T> | undefined)?.[name];
}

/** Every string of text anywhere in the tree, flattened. */
function textOf(root: ReactNode): string {
  const parts: string[] = [];
  for (const el of walk(root)) {
    const children = (el.props as { children?: unknown }).children;
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

/** The rendered list, for a loaded board. */
function render(board: Board, props: Partial<Parameters<typeof ListView>[0]> = {}) {
  return ListView({
    loadState: { status: "loaded", board },
    personId: null,
    now: Date.parse("2026-01-01T00:00:00.000Z"),
    ...props,
  });
}

describe("the list's derivations", () => {
  it("puts every column's entries in one sequence, in board order", () => {
    // The list's whole claim is that it shows the same set as the kanban.
    // The order asserted here is `BOARD_COLUMNS` order — reordering that
    // constant, or flattening the columns in any other order, is what this
    // catches.
    const board = boardOf({
      backlog: [entry("backlog", { id: "b1" })],
      in_progress: [entry("in_progress", { id: "p1" })],
      waiting: [entry("waiting", { id: "w1" })],
      completed: [entry("completed", { id: "c1" })],
    });
    expect(listEntries(board).map((e) => e.item.id)).toEqual(["b1", "p1", "w1", "c1"]);
  });

  it("keeps a column's entries in the order the server returned them", () => {
    // The sort is the SERVER's answer. A list that re-sorted client-side
    // would silently show a different order from the kanban for the same
    // `sort` parameter — inserting a `.sort()` into `listEntries` is the
    // change this catches.
    const board = boardOf({
      backlog: [
        entry("backlog", { id: "z", title: "Zebra" }),
        entry("backlog", { id: "a", title: "Apple" }),
      ],
    });
    expect(listEntries(board).map((e) => e.item.id)).toEqual(["z", "a"]);
  });

  it("names every column as a section, including the empty ones", () => {
    // A section that vanished when its column emptied would take its
    // heading and its count with it, and a reader could not tell "empty"
    // from "not drawn". Adding a `.filter(s => s.section.entries.length)`
    // to `listSections` is what this catches.
    const sections = listSections(emptyBoard());
    expect(sections.map((s) => s.column)).toEqual([
      "backlog",
      "in_progress",
      "waiting",
      "completed",
    ]);
    expect(sections.map((s) => s.title)).toEqual([
      "Backlog",
      "In progress",
      "Waiting",
      "Completed",
    ]);
  });

  it("counts shown rows and total rows as DIFFERENT quantities", () => {
    // MILESTONES.md #123, reached from the list's side: `shown` is what was
    // rendered, `total` what the server counted. Changing `listTotal` to
    // sum `entries.length` — the tempting simplification — makes both 2
    // here and makes a 68-item backlog read as 8.
    const board: Board = {
      ...emptyBoard(),
      backlog: section([entry("backlog", { id: "b1" }), entry("backlog", { id: "b2" })], {
        total: 68,
        nextCursor: "cursor-1",
      }),
    };
    expect(listShown(board)).toBe(2);
    expect(listTotal(board)).toBe(68);
  });

  it("reports more to load when a column was withheld, not only when it has a cursor", () => {
    // A withheld column has NO cursor and has never been read, so a check
    // on `nextCursor` alone reports "nothing more" about a column holding
    // 175 items. Dropping the `|| withheld` clause is what this catches.
    const withheld: Board = {
      ...emptyBoard(),
      completed: { entries: [], total: 175, nextCursor: null, withheld: true },
    };
    expect(hasMore(withheld)).toBe(true);
    expect(hasMore(emptyBoard())).toBe(false);
  });
});

describe("the list renders the same set as the kanban", () => {
  it("renders one row per entry, across every column", () => {
    const board = boardOf({
      backlog: [entry("backlog", { id: "b1" }), entry("backlog", { id: "b2" })],
      in_progress: [entry("in_progress", { id: "p1" })],
      completed: [entry("completed", { id: "c1" })],
    });
    const tree = render(board);
    // Four entries in, four rows out. A section that dropped its entries —
    // or rendered them twice — changes this number.
    expect(findAllByType(tree, "tr").filter((r) => propOf(r, "className"))).toHaveLength(4);
  });

  it("links each row to its detail page, and a PROJECT to the project page", () => {
    // The same rule `ItemCard` follows: a project's stored `state` is a
    // creation leftover, so `/items/{id}` would render a reading nobody
    // wrote. Collapsing the ternary in `detailHref` to one branch is what
    // this catches.
    const board = boardOf({
      backlog: [
        entry("backlog", { id: "task-1", kind: "task" }),
        entry("backlog", { id: "proj-1", kind: "project" }),
      ],
    });
    const hrefs = findAllByType(render(board), Link).map((l) => propOf<string>(l, "href"));
    expect(hrefs).toContain("/items/task-1");
    expect(hrefs).toContain("/projects/proj-1");
  });

  it("shows the server's counted total in a section heading, never the page length", () => {
    // MILESTONES.md #123 in the heading. Swapping `columnCount(section)`
    // for `section.entries.length` makes this read 2.
    //
    // **Asserted on the heading element itself, not on flattened page
    // text.** A `textOf(...).toContain("68")` passes here for the wrong
    // reason — the "Showing 2 of 68" caption also contains 68 — so it
    // survives the very mutation it claims to catch. Found by hand-
    // mutating this exact line; the page-text version was the one hollow
    // test in this file.
    const board: Board = {
      ...emptyBoard(),
      backlog: section([entry("backlog", { id: "b1" }), entry("backlog", { id: "b2" })], {
        total: 68,
      }),
    };
    const heading = [...walk(render(board))].find((el) => el.type === "h2");
    const children = (heading?.props as { children: unknown[] }).children.flat();
    // The heading's own count element, holding the SERVER's total (68) and
    // not the two rows this page happens to carry.
    const count = children.find(
      (c): c is { props: { children: number } } =>
        typeof c === "object" && c !== null && "props" in c,
    );
    expect(count?.props.children).toBe(68);
  });

  it("says how many of the total it is showing", () => {
    // The caption that stops a reader concluding a paginated list is
    // complete. Asserted on the summary element's own children rather than
    // on flattened page text, because JSX splits `Showing {n} of {m}` into
    // five children and any whitespace-joining helper would be asserting
    // its own join rather than the caption.
    const board: Board = {
      ...emptyBoard(),
      backlog: section([entry("backlog", { id: "b1" })], { total: 68 }),
    };
    const summary = [...walk(render(board))].find(
      (el) => propOf<string>(el, "data-testid") === "list-summary",
    );
    // The two numbers are DIFFERENT quantities — 1 rendered, 68 counted.
    // Swapping `listTotal` for `listShown` in the component makes this
    // "Showing 1 of 1", which is the paginated-list-looks-complete defect.
    const children = (summary?.props as { children: unknown[] }).children.flat();
    expect(children).toEqual(["Showing ", 1, " of ", 68]);
  });

  it("withholds the state chip on a project and marks it as one instead", () => {
    // A project's own `state` is not its column (`get-board.ts`), so
    // rendering a chip from it would print a reading nobody wrote.
    const projectOnly = boardOf({ backlog: [entry("backlog", { kind: "project" })] });
    const taskOnly = boardOf({ backlog: [entry("backlog", { kind: "task" })] });
    expect(findAllByType(render(projectOnly), StateChip)).toHaveLength(0);
    expect(findAllByType(render(taskOnly), StateChip)).toHaveLength(1);
  });

  it("renders a priority chip on every row", () => {
    const board = boardOf({
      backlog: [entry("backlog", { id: "b1" }), entry("backlog", { id: "b2" })],
    });
    expect(findAllByType(render(board), PriorityChip)).toHaveLength(2);
  });
});

describe("the list carries the amber/red split", () => {
  it("tones a paused row amber and a blocked row red", () => {
    // SCHEMA.md §1.1 makes the split a property of the DATA, so a layout
    // that dropped it would show paused and blocked as the same thing.
    // Removing the `data-tone` spread is what this catches.
    const board = boardOf({
      waiting: [
        entry("waiting", { id: "paused-1", state: "paused" }),
        entry("waiting", { id: "blocked-1", state: "blocked" }),
      ],
    });
    const tones = findAllByType(render(board), "tr")
      .map((r) => propOf<string>(r, "data-tone"))
      .filter(Boolean);
    expect(tones).toEqual(["amber", "red"]);
  });

  it("does not tone a row outside the Waiting column", () => {
    // `waitingTone` already refuses; this proves the list asks it rather
    // than reading `state` directly. Inline the tone as
    // `entry.item.state === "paused" ? "amber" : null` and a paused row
    // sitting in another column gets toned.
    const board = boardOf({ backlog: [entry("backlog", { state: "paused" })] });
    const row = findAllByType(render(board), "tr").find((r) => propOf(r, "className"));
    expect(propOf<string>(row, "data-tone")).toBeUndefined();
  });

  it("marks a row that needs the active reader, and only for that reader", () => {
    const board = boardOf({
      waiting: [
        entry("waiting", {
          id: "mine",
          state: "blocked",
          blockedOnType: "person",
          blockedOnPersonId: "ope",
        }),
      ],
    });
    const marked = (tree: ReactNode) =>
      findAllByType(tree, "tr").some((r) => propOf<string>(r, "data-needs-you") === "true");
    expect(marked(render(board, { personId: "ope" }))).toBe(true);
    // Blocked on someone else is on THEIR badge, not yours — passing the
    // wrong id must not mark the row.
    expect(marked(render(board, { personId: "tomi" }))).toBe(false);
  });

  it("shows why a waiting row is waiting", () => {
    // In a list the tone alone is thin — the words are what answer "why is
    // this here".
    const board = boardOf({
      waiting: [entry("waiting", { state: "blocked", blockedReason: "Needs a decision from Ope" })],
    });
    expect(textOf(render(board))).toContain("Needs a decision from Ope");
  });
});

describe("the list's empty, withheld and error states", () => {
  it("distinguishes a withheld section from a genuinely empty one", () => {
    // #123: "an empty state and a hidden state must not render
    // identically". Both have zero entries; only `withheld` has a total.
    const board: Board = {
      ...emptyBoard(),
      completed: { entries: [], total: 175, nextCursor: null, withheld: true },
    };
    const kinds = findAllByType(render(board), EmptyState).map((e) => propOf<string>(e, "kind"));
    expect(kinds).toContain("withheld");
    expect(kinds).toContain("empty");
  });

  it("blames the filter when one is narrowing a section that has content", () => {
    // The only one of the states the reader can fix, so it is the only one
    // that carries an action. Dropping the `filtered` prop makes this
    // "empty" and strips the reader's way back to their data.
    const board: Board = {
      ...emptyBoard(),
      backlog: { entries: [], total: 12, nextCursor: null, withheld: false },
    };
    const kinds = findAllByType(render(board, { filtered: true }), EmptyState).map((e) =>
      propOf<string>(e, "kind"),
    );
    expect(kinds).toContain("filtered");
  });

  it("reports a failed load with the message the fetch produced", () => {
    const tree = ListView({
      loadState: {
        status: "error",
        message: "Could not load the board (GET /api/board returned 500).",
      },
      personId: null,
      now: 0,
    });
    const error = findAllByType(tree, ErrorState);
    expect(error).toHaveLength(1);
    expect(propOf<string>(error[0], "message")).toContain("500");
  });

  it("shows a skeleton while loading rather than an empty list", () => {
    // An empty list and a loading list must not render identically — a
    // reader would conclude there is nothing there.
    const tree = ListView({ loadState: { status: "loading" }, personId: null, now: 0 });
    expect(findAllByType(tree, LoadingState)).toHaveLength(1);
    expect(findAllByType(tree, "tr")).toHaveLength(0);
  });

  it("reports one section's failed page under that section only", () => {
    // One section's failed page says nothing about the other three.
    const board = boardOf({ backlog: [entry("backlog")] });
    const tree = render(board, {
      paging: {
        onShowMore: () => {},
        loadingColumns: {},
        errors: { backlog: "Could not load the board (GET /api/board returned 500)." },
      },
    });
    expect(findAllByType(tree, ErrorState)).toHaveLength(1);
  });
});

describe("the list pages each section independently", () => {
  it("offers 'show more' only where the server left a cursor", () => {
    const board: Board = {
      ...emptyBoard(),
      backlog: section([entry("backlog", { id: "b1" })], { total: 68, nextCursor: "c1" }),
      in_progress: section([entry("in_progress", { id: "p1" })], { total: 1 }),
    };
    const tree = render(board, {
      paging: { onShowMore: () => {}, loadingColumns: {}, errors: {} },
    });
    const buttons = findAllByType(tree, "button");
    expect(buttons).toHaveLength(1);
  });

  it("asks for the right column when 'show more' is pressed", () => {
    // The handler is just a function reference on the element — invoking it
    // proves the column is bound correctly. Hard-coding `"backlog"` in the
    // component would pass a single-section test and fail this one.
    const asked: BoardColumnId[] = [];
    const board: Board = {
      ...emptyBoard(),
      completed: section([entry("completed", { id: "c1" })], { total: 175, nextCursor: "c1" }),
    };
    const tree = render(board, {
      paging: { onShowMore: (c) => asked.push(c), loadingColumns: {}, errors: {} },
    });
    const button = findAllByType(tree, "button")[0];
    propOf<() => void>(button, "onClick")?.();
    expect(asked).toEqual(["completed"]);
  });

  it("binds a WITHHELD section's load control to its own column", () => {
    // The withheld section offers its load through the empty state's
    // `onLoad` rather than through the "show more" button, so it is a
    // SECOND call site for the same column binding — and one a test of the
    // button alone leaves uncovered. Found by hand-mutating that exact
    // line: hard-coding `"backlog"` there survived every other test in
    // this file.
    const asked: BoardColumnId[] = [];
    const board: Board = {
      ...emptyBoard(),
      completed: { entries: [], total: 175, nextCursor: null, withheld: true },
    };
    const tree = render(board, {
      paging: { onShowMore: (c) => asked.push(c), loadingColumns: {}, errors: {} },
    });
    const withheld = findAllByType(tree, EmptyState).find(
      (e) => propOf<string>(e, "kind") === "withheld",
    );
    propOf<() => void>(withheld, "onLoad")?.();
    expect(asked).toEqual(["completed"]);
  });

  it("disables the control for the column whose page is in flight, and only that one", () => {
    const board: Board = {
      ...emptyBoard(),
      backlog: section([entry("backlog", { id: "b1" })], { total: 68, nextCursor: "c1" }),
      completed: section([entry("completed", { id: "c1" })], { total: 175, nextCursor: "c2" }),
    };
    const tree = render(board, {
      paging: { onShowMore: () => {}, loadingColumns: { backlog: true }, errors: {} },
    });
    const disabled = findAllByType(tree, "button").map((b) => propOf<boolean>(b, "disabled"));
    expect(disabled).toEqual([true, false]);
  });
});

describe("the layout toggle", () => {
  it("offers both layouts as real links", () => {
    // Links, not buttons: choosing a layout is a navigation, so it must be
    // middle-clickable and openable in a new tab. Swapping `<Link>` for a
    // `<button onClick>` is what this catches.
    const links = findAllByType(LayoutToggle({ query: parseBoardQuery("") }), Link);
    expect(links).toHaveLength(2);
  });

  it("builds each link from the CURRENT filters, so the toggle preserves them", () => {
    // The rendered half of the acceptance criterion — the encoder half is
    // in `board-layout-url.test.ts`. A toggle that hard-coded
    // `/board?layout=list` would pass every other test here and silently
    // drop the reader's filters.
    const query = parseBoardQuery("area=web&priority=P0&sort=name");
    const hrefs = findAllByType(LayoutToggle({ query }), Link).map((l) =>
      propOf<string>(l, "href"),
    );
    expect(hrefs).toEqual([
      "/board?area=web&priority=P0&sort=name",
      "/board?area=web&priority=P0&sort=name&layout=list",
    ]);
  });

  it("marks the layout in force, and only it", () => {
    const activeOf = (qs: string) =>
      findAllByType(LayoutToggle({ query: parseBoardQuery(qs) }), Link).map((l) =>
        propOf<boolean>(l, "data-active"),
      );
    expect(activeOf("")).toEqual([true, false]);
    expect(activeOf("layout=list")).toEqual([false, true]);
  });

  it("announces the current option with aria-current rather than leaving it unmarked", () => {
    // A visual fill alone tells a screen-reader user nothing. Dropping the
    // `aria-current` spread is what this catches.
    const links = findAllByType(LayoutToggle({ query: parseBoardQuery("layout=list") }), Link);
    const current = links.map((l) => propOf<string>(l, "aria-current"));
    expect(current).toEqual([undefined, "true"]);
  });
});
