// The drag wiring on the board's components — MILESTONES.md #73.
//
// Hook-free and prop-driven, so the components are called directly as
// functions and their returned element trees inspected — and, because a
// handler in that tree is just a function reference, it can be invoked
// directly to prove it calls back with the right arguments. Same technique
// as `tests/board-view-component.test.ts`.
import { describe, expect, it, vi } from "vitest";
import { BoardView, type BoardDragProps } from "@/components/board/BoardView";
import { BoardColumn } from "@/components/board/BoardColumn";
import { ItemCard } from "@/components/board/ItemCard";
import type { Board, BoardColumnId, BoardEntry, BoardItem } from "@/lib/board/types";
import { boardOf, section } from "./helpers/board-sections";
import { walk } from "./helpers/react-element";
import type { ReactNode } from "react";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-1",
    title: "An item",
    // The BLUF (MILESTONES.md #107). Null in the default fixture so a case
    // that cares about it has to say so, rather than every card silently
    // carrying one.
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
  // These fixtures are about drag, tone and tallies; ownership is proved
  // against real data in the operation's own suites. An empty list is what
  // the API sends for an item nobody holds, so it is the honest default.
  return { item: item(overrides), column, assignments: [], trust: null };
}

/**
 * A board whose named columns hold the given entries.
 *
 * Takes bare entry lists rather than whole sections: a column's count and
 * cursor (MILESTONES.md #109, #123) are proved against real data in
 * `tests/board-pagination.test.ts`, and restating them at every fixture
 * site here would bury what these tests are actually about.
 */
function boardWith(overrides: Partial<Record<BoardColumnId, readonly BoardEntry[]>> = {}): Board {
  return boardOf(overrides);
}

function dragProps(overrides: Partial<BoardDragProps> = {}): BoardDragProps {
  return {
    onCardDragStart: vi.fn(),
    onCardDragEnd: vi.fn(),
    onDrop: vi.fn(),
    onDragEnter: vi.fn(),
    overColumn: null,
    pendingItemId: null,
    refusal: null,
    onDismissRefusal: vi.fn(),
    ...overrides,
  };
}

function textOf(root: ReactNode): string {
  const parts: string[] = [];
  for (const el of walk(root)) {
    const children = (el.props as { children?: unknown }).children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

/** A minimal stand-in for a drag event — only `preventDefault` is read. */
function dragEvent() {
  return { preventDefault: vi.fn() };
}

/** A stand-in for a dragstart event, whose `dataTransfer` the card writes its payload to. */
function dragStartEvent() {
  return { dataTransfer: { effectAllowed: "", setData: vi.fn() } };
}

describe("ItemCard — what can be picked up", () => {
  it("is draggable when drag is wired up", () => {
    const card = ItemCard({
      entry: entry("backlog"),
      needsYou: false,
      onDragStart: vi.fn(),
    });
    expect((card.props as { draggable?: boolean }).draggable).toBe(true);
  });

  it("is NOT draggable when no drag is wired up", () => {
    // A card that is draggable but tells nobody it moved would drag to
    // nowhere.
    const card = ItemCard({ entry: entry("backlog"), needsYou: false });
    expect((card.props as { draggable?: boolean }).draggable).toBe(false);
  });

  it("is NOT draggable when it is a project", () => {
    // DECISIONS.md §13c — a project has no state of its own to transition,
    // so the gesture is not offered rather than offered and always refused.
    const card = ItemCard({
      entry: entry("waiting", { kind: "project" }),
      needsYou: false,
      onDragStart: vi.fn(),
    });
    expect((card.props as { draggable?: boolean }).draggable).toBe(false);
    expect((card.props as { onDragStart?: unknown }).onDragStart).toBeUndefined();
  });

  it("reports its own id when a drag starts", () => {
    const onDragStart = vi.fn();
    const card = ItemCard({
      entry: entry("backlog", { id: "item-42" }),
      needsYou: false,
      onDragStart,
    });
    (card.props as { onDragStart: (e: unknown) => void }).onDragStart(dragStartEvent());
    expect(onDragStart).toHaveBeenCalledWith("item-42");
  });

  it("claims the drag payload, so a drag begun on the title link is still a card drag", () => {
    // A card's title is a link into the detail view, and an anchor is
    // natively draggable. Without claiming the payload here, a drag started
    // on the title would be the browser's own link-drag carrying the URL,
    // and dropping it on a column would do nothing at all.
    const event = dragStartEvent();
    const card = ItemCard({
      entry: entry("backlog", { id: "item-42" }),
      needsYou: false,
      onDragStart: vi.fn(),
    });
    (card.props as { onDragStart: (e: unknown) => void }).onDragStart(event);

    expect(event.dataTransfer.setData).toHaveBeenCalledWith("text/plain", "item-42");
    expect(event.dataTransfer.effectAllowed).toBe("move");
  });

  it("marks itself pending while its move is in flight", () => {
    const card = ItemCard({
      entry: entry("backlog"),
      needsYou: false,
      onDragStart: vi.fn(),
      pending: true,
    });
    expect((card.props as { "data-pending"?: boolean })["data-pending"]).toBe(true);
  });
});

describe("BoardColumn — what can be dropped on", () => {
  it("reports the column it is when something is dropped on it", () => {
    const onDrop = vi.fn();
    const column = BoardColumn({
      column: "in_progress",
      section: section([]),
      personId: null,
      onDrop,
    });
    const event = dragEvent();
    (column.props as { onDrop: (e: unknown) => void }).onDrop(event);
    expect(onDrop).toHaveBeenCalledWith("in_progress");
  });

  it("preventDefaults dragOver, which is what makes a drop possible at all", () => {
    // Without this the browser refuses the drop, `onDrop` never fires, and
    // the card springs back with no request ever having been made — a
    // failure that looks exactly like a rejected move.
    const column = BoardColumn({
      column: "in_progress",
      section: section([]),
      personId: null,
      onDrop: vi.fn(),
    });
    const event = dragEvent();
    (column.props as { onDragOver: (e: unknown) => void }).onDragOver(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("preventDefaults the drop itself", () => {
    const column = BoardColumn({
      column: "backlog",
      section: section([]),
      personId: null,
      onDrop: vi.fn(),
    });
    const event = dragEvent();
    (column.props as { onDrop: (e: unknown) => void }).onDrop(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("takes no drop handlers even with drag wired up, when the column accepts none", () => {
    // Waiting: both its states need fields a drag has not got, so it is not
    // a target at all rather than one that always refuses.
    const column = BoardColumn({
      column: "waiting",
      section: section([]),
      personId: null,
      onDrop: vi.fn(),
    });
    const props = column.props as Record<string, unknown>;
    expect(props.onDrop).toBeUndefined();
    expect(props.onDragOver).toBeUndefined();
  });

  it("does not highlight a column that cannot be dropped on", () => {
    // The highlight is a promise that letting go here will do something.
    const column = BoardColumn({
      column: "waiting",
      section: section([]),
      personId: null,
      onDrop: vi.fn(),
      isDropTarget: true,
    });
    expect((column.props as { "data-drop-target"?: boolean })["data-drop-target"]).toBeUndefined();
  });

  it("takes no drop handlers at all when drag is not wired up", () => {
    const column = BoardColumn({ column: "backlog", section: section([]), personId: null });
    const props = column.props as Record<string, unknown>;
    expect(props.onDrop).toBeUndefined();
    expect(props.onDragOver).toBeUndefined();
  });

  it("marks itself as the drop target while a card is over it", () => {
    const column = BoardColumn({
      column: "in_progress",
      section: section([]),
      personId: null,
      onDrop: vi.fn(),
      isDropTarget: true,
    });
    expect((column.props as { "data-drop-target"?: boolean })["data-drop-target"]).toBe(true);
  });

  it("passes pending only to the card whose move is in flight", () => {
    const column = BoardColumn({
      column: "backlog",
      section: section([entry("backlog", { id: "a" }), entry("backlog", { id: "b" })]),
      personId: null,
      onDrop: vi.fn(),
      onCardDragStart: vi.fn(),
      pendingItemId: "a",
    });
    const cards = [...walk(column)].filter((el) => el.type === ItemCard);
    const pending = cards.map((el) => {
      const props = el.props as { entry: BoardEntry; pending?: boolean };
      return [props.entry.item.id, props.pending] as const;
    });
    expect(pending).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });
});

describe("BoardView — reporting a refusal", () => {
  it("shows the refusal message when there is one", () => {
    // The revert has already happened by the time this renders; saying why
    // is what separates "the server refused" from "the interface broke".
    const element = BoardView({
      loadState: { status: "loaded", board: boardWith() },
      personId: null,
      drag: dragProps({ refusal: "A summary is required." }),
    });
    expect(textOf(element)).toContain("A summary is required.");
  });

  it("announces the refusal, since a visual revert is not perceivable to everyone", () => {
    const element = BoardView({
      loadState: { status: "loaded", board: boardWith() },
      personId: null,
      drag: dragProps({ refusal: "nope" }),
    });
    const alerts = [...walk(element)].filter(
      (el) => (el.props as { role?: string }).role === "alert",
    );
    expect(alerts).toHaveLength(1);
  });

  it("shows nothing when there is no refusal", () => {
    const element = BoardView({
      loadState: { status: "loaded", board: boardWith() },
      personId: null,
      drag: dragProps({ refusal: null }),
    });
    const alerts = [...walk(element)].filter(
      (el) => (el.props as { role?: string }).role === "alert",
    );
    expect(alerts).toHaveLength(0);
  });

  it("can dismiss the refusal", () => {
    const onDismissRefusal = vi.fn();
    const element = BoardView({
      loadState: { status: "loaded", board: boardWith() },
      personId: null,
      drag: dragProps({ refusal: "nope", onDismissRefusal }),
    });
    const button = [...walk(element)].find((el) => el.type === "button");
    (button!.props as { onClick: () => void }).onClick();
    expect(onDismissRefusal).toHaveBeenCalled();
  });

  it("renders a board with no drag wired up at all", () => {
    // The board is still usable read-only — every drag prop is optional.
    // Asserted on the props handed to the columns rather than on rendered
    // text: `BoardColumn` is a nested component, so it appears in this tree
    // as a reference, and its own output is not reachable from here.
    const element = BoardView({
      loadState: { status: "loaded", board: boardWith({ backlog: [entry("backlog")] }) },
      personId: null,
    });
    const columns = [...walk(element)].filter((el) => el.type === BoardColumn);
    expect(columns).toHaveLength(4);
    const backlog = columns[0]!.props as {
      section: { entries: readonly BoardEntry[] };
      onDrop?: unknown;
      onCardDragStart?: unknown;
    };
    expect(backlog.section.entries).toHaveLength(1);
    expect(backlog.onDrop).toBeUndefined();
    expect(backlog.onCardDragStart).toBeUndefined();
  });

  it("marks only the column being dragged over as the target", () => {
    const element = BoardView({
      loadState: { status: "loaded", board: boardWith() },
      personId: null,
      drag: dragProps({ overColumn: "in_progress" }),
    });
    const targets = [...walk(element)]
      .filter((el) => el.type === BoardColumn)
      .map((el) => {
        const props = el.props as { column: string; isDropTarget?: boolean };
        return [props.column, props.isDropTarget] as const;
      });
    expect(targets).toEqual([
      ["backlog", false],
      ["in_progress", true],
      ["waiting", false],
      ["completed", false],
    ]);
  });
});
