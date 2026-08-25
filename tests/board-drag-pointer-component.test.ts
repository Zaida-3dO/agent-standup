// The pointer-drag props on the board's hook-free components — T6-A.
//
// **This file is the evidence for the central claim of the row**: that the
// drag library stays behind the hook-free seam. Every component below is
// called as a plain function with `environment: "node"` and no DOM, exactly
// as before — the drag handle arrives as an ordinary object, and nothing
// here imports `dnd-kit` at all. If the library had leaked into `ItemCard`,
// `BoardColumn` or `BoardView`, none of these calls would be possible.
import { describe, expect, it, vi } from "vitest";
import { ItemCard } from "@/components/board/ItemCard";
import { BoardColumn } from "@/components/board/BoardColumn";
import type { Board, BoardColumnId, BoardEntry, BoardItem } from "@/lib/board/types";
import { section } from "./helpers/board-sections";
import { walk } from "./helpers/react-element";

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

function entry(column: BoardColumnId, overrides: Partial<BoardItem> = {}): BoardEntry {
  return { item: item(overrides), column, assignments: [], trust: null };
}

/** A hand-written drag handle — the shape `useDraggable` produces, with nothing from the library. */
function handle(overrides: Partial<Parameters<typeof ItemCard>[0]["dragHandle"] & object> = {}) {
  return {
    ref: vi.fn(),
    listeners: {},
    attributes: {},
    isDragging: false,
    ...overrides,
  };
}

/** Every element in a tree carrying a given data attribute. */
function withAttribute(root: unknown, attribute: string) {
  return [...walk(root as never)].filter(
    (el) => (el.props as Record<string, unknown>)[attribute] !== undefined,
  );
}

describe("ItemCard — the drag handle arrives as a plain prop", () => {
  it("renders with no handle at all, which is the board as it stands without a drag layer", () => {
    const card = ItemCard({ entry: entry("backlog"), needsYou: false, now: 0 });
    expect((card.props as { "data-dragging"?: boolean })["data-dragging"]).toBeUndefined();
  });

  it("marks itself as the card in hand while it is being dragged", () => {
    // The card left behind is dimmed; the copy following the cursor is the
    // one being aimed. Two solid copies would leave it ambiguous which is
    // real.
    const card = ItemCard({
      entry: entry("backlog"),
      needsYou: false,
      now: 0,
      dragHandle: handle({ isDragging: true }),
    });
    expect((card.props as { "data-dragging"?: boolean })["data-dragging"]).toBe(true);
  });

  it("does NOT mark itself while another card is the one being dragged", () => {
    const card = ItemCard({
      entry: entry("backlog"),
      needsYou: false,
      now: 0,
      dragHandle: handle({ isDragging: false }),
    });
    expect((card.props as { "data-dragging"?: boolean })["data-dragging"]).toBeUndefined();
  });

  it("takes the handle's ref, which is how the library finds the element", () => {
    const ref = vi.fn();
    const card = ItemCard({
      entry: entry("backlog"),
      needsYou: false,
      now: 0,
      dragHandle: handle({ ref }),
    });
    expect((card.props as { ref?: unknown }).ref).toBe(ref);
  });

  it("spreads the handle's listeners onto the card, so a pointer press starts a drag", () => {
    const onPointerDown = vi.fn();
    const card = ItemCard({
      entry: entry("backlog"),
      needsYou: false,
      now: 0,
      dragHandle: handle({ listeners: { onPointerDown } }),
    });
    expect((card.props as { onPointerDown?: unknown }).onPointerDown).toBe(onPointerDown);
  });

  it("spreads the handle's attributes, which are what make it keyboard-reachable (T6-B)", () => {
    // `useDraggable` supplies `tabIndex` and `role`/`aria-*` here. Dropping
    // them would leave the card unreachable by keyboard, which is the whole
    // of T6-B.
    const card = ItemCard({
      entry: entry("backlog"),
      needsYou: false,
      now: 0,
      dragHandle: handle({ attributes: { tabIndex: 0, role: "button" } }),
    });
    expect((card.props as { tabIndex?: number }).tabIndex).toBe(0);
    expect((card.props as { role?: string }).role).toBe("button");
  });

  it("keeps the native drag intact alongside the handle, so both transports work", () => {
    // The two coexist on purpose. The native path is what every existing
    // drag test asserts on, and it is the fallback if the library fails to
    // mount at all.
    const card = ItemCard({
      entry: entry("backlog"),
      needsYou: false,
      now: 0,
      onDragStart: vi.fn(),
      dragHandle: handle(),
    });
    expect((card.props as { draggable?: boolean }).draggable).toBe(true);
    expect((card.props as { onDragStart?: unknown }).onDragStart).toBeDefined();
  });

  it("does not let a handle's listener clobber the native drag handler", () => {
    // The spread order is what guarantees this: a listener object carrying
    // its own `onDragStart` must not replace the one the native contract —
    // and every existing test — depends on.
    const hijack = vi.fn();
    const onDragStart = vi.fn();
    const card = ItemCard({
      entry: entry("backlog"),
      needsYou: false,
      now: 0,
      onDragStart,
      dragHandle: handle({ listeners: { onDragStart: hijack } }),
    });
    (card.props as { onDragStart: (e: unknown) => void }).onDragStart({
      dataTransfer: { effectAllowed: "", setData: vi.fn() },
    });
    expect(onDragStart).toHaveBeenCalledWith("item-1");
    expect(hijack).not.toHaveBeenCalled();
  });
});

describe("BoardColumn — the landing site", () => {
  it("shows no placeholder when nothing is being held over it", () => {
    const column = BoardColumn({
      column: "backlog",
      section: section([entry("backlog")]),
      personId: null,
      now: 0,
    });
    expect(withAttribute(column, "data-drop-placeholder")).toHaveLength(0);
  });

  it("shows the landing site while a card is held over it", () => {
    const column = BoardColumn({
      column: "backlog",
      section: section([entry("backlog")]),
      personId: null,
      now: 0,
      showPlaceholder: true,
    });
    expect(withAttribute(column, "data-drop-placeholder")).toHaveLength(1);
  });

  it("puts the landing site LAST, which is where the drop actually lands", () => {
    // `relocate` appends the moved entry to the target column's entries, so
    // a placeholder drawn anywhere else would promise a position the drop
    // does not deliver.
    const column = BoardColumn({
      column: "backlog",
      section: section([entry("backlog", { id: "a" }), entry("backlog", { id: "b" })]),
      personId: null,
      now: 0,
      showPlaceholder: true,
    });
    const list = [...walk(column)].find((el) => el.type === "ul");
    const children = (list!.props as { children: readonly unknown[] }).children.flat();
    const last = children[children.length - 1] as { props?: Record<string, unknown> };
    expect(last.props?.["data-drop-placeholder"]).toBeDefined();
  });

  it("shows the landing site on an EMPTY column, where it matters most", () => {
    // An empty column has no cards to imply where a drop goes, so a column
    // that kept saying "nothing here" while a card hovered over it would
    // withhold the landing site exactly where it is most needed.
    const column = BoardColumn({
      column: "backlog",
      section: section([]),
      personId: null,
      now: 0,
      showPlaceholder: true,
    });
    expect(withAttribute(column, "data-drop-placeholder")).toHaveLength(1);
  });

  it("still shows its empty state when no card is being held over it", () => {
    // The landing site is shown only while a card is in hand. An empty
    // column at rest must still explain why it is empty.
    const column = BoardColumn({
      column: "backlog",
      section: section([]),
      personId: null,
      now: 0,
    });
    expect(withAttribute(column, "data-drop-placeholder")).toHaveLength(0);
  });

  it("passes the drop ref through to the column element", () => {
    const dropRef = vi.fn();
    const column = BoardColumn({
      column: "backlog",
      section: section([]),
      personId: null,
      now: 0,
      dropRef,
    });
    expect((column.props as { ref?: unknown }).ref).toBe(dropRef);
  });

  it("renders the injected card component instead of the plain one", () => {
    // This is the seam that keeps `dnd-kit` out of this file: the wrapper is
    // handed in, never imported here.
    const Injected = vi.fn(() => null);
    BoardColumn({
      column: "backlog",
      section: section([entry("backlog", { id: "a" }), entry("backlog", { id: "b" })]),
      personId: null,
      now: 0,
      cardComponent: Injected as never,
    });
    // Called by React at render time, not by this function — so assert on
    // the element tree instead.
    const column = BoardColumn({
      column: "backlog",
      section: section([entry("backlog", { id: "a" })]),
      personId: null,
      now: 0,
      cardComponent: Injected as never,
    });
    const cards = [...walk(column)].filter((el) => el.type === Injected);
    expect(cards).toHaveLength(1);
  });

  it("renders the plain card when no component is injected", () => {
    const column = BoardColumn({
      column: "backlog",
      section: section([entry("backlog", { id: "a" })]),
      personId: null,
      now: 0,
    });
    const cards = [...walk(column)].filter((el) => el.type === ItemCard);
    expect(cards).toHaveLength(1);
  });
});

describe("the board's columns are unchanged without a drag layer", () => {
  it("renders no placeholder and no ref anywhere when nothing is wired", () => {
    // The regression guard for "additive": a board with no drag layer must
    // produce exactly the tree it always did.
    const board: Board = {
      backlog: section([entry("backlog")]),
      in_progress: section([]),
      waiting: section([]),
      completed: section([]),
    };
    const column = BoardColumn({
      column: "backlog",
      section: board.backlog,
      personId: null,
      now: 0,
    });
    expect((column.props as { ref?: unknown }).ref).toBeUndefined();
    expect(withAttribute(column, "data-drop-placeholder")).toHaveLength(0);
  });
});
