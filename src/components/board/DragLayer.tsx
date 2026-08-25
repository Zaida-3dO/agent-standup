"use client";

// The pointer-and-keyboard drag transport — T6-A and T6-B.
//
// ── Why this file exists, and why it is the ONLY one with `dnd-kit` in it ──
//
// Every presentational component on this board is deliberately hook-free so
// a test can call it as a plain function and inspect the element tree it
// returns (`tests/helpers/react-element.ts`), with no DOM at all. `dnd-kit`
// is hooks-and-context-first and cannot satisfy that.
//
// The resolution is that this repo's hook-free rule is a **component
// boundary, not a file boundary**: `Board.tsx` already holds every hook on
// the board and hands `BoardView` plain props. So the drag library lives
// here, on the container side of that line, and everything it produces
// reaches the pure components as ordinary props — `dragHandle` on a card,
// `isDropTarget` on a column. `ItemCard`, `BoardColumn` and `BoardView`
// import nothing from `dnd-kit` and are still called directly in
// `tests/board-drag-component.test.ts` with no renderer.
//
// **The native HTML5 drag is deliberately still there.** This layer is
// additive. The card keeps its `draggable` attribute and its `dataTransfer`
// payload, and the column keeps its `onDragOver`/`onDrop` — so a browser
// drag still works exactly as it did, and every existing test in
// `tests/board-drag-component.test.ts` passes unmodified. What the native
// path never had was a drag image, which is the entire defect this row
// fixes; that is what the overlay below supplies.
//
// **Both transports converge on the same pure logic.** The handlers here
// call the same `dragStarted` / `draggedOver` / `dropped` path from
// `@/lib/board/drag-state` that the native path calls, by way of the props
// `Board.tsx` passes down. Nothing in `drag.ts`, `drag-state.ts`,
// `drop-handler.ts` or `move.ts` was changed by this row, and `TARGET_STATE`
// remains the single source of truth for which columns accept a drop
// (reached here through `isDropZone`).
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { BOARD_COLUMNS, type Board, type BoardColumnId, type BoardEntry } from "@/lib/board/types";
import { findEntry } from "@/lib/board/drag";
import { isDropZone } from "@/lib/board/drag-visual";
import { primaryLine } from "@/lib/item-headline-display";
import {
  cancelledMessage,
  droppedMessage,
  movedOverMessage,
  pickedUpMessage,
} from "@/lib/board/drag-announce";
import { DragCardPreview } from "./DragCardPreview";
import styles from "./Board.module.css";

/** True when an id is one of the board's columns — a drop can land anywhere, so this is checked. */
function isBoardColumn(id: unknown): id is BoardColumnId {
  return typeof id === "string" && (BOARD_COLUMNS as readonly string[]).includes(id);
}

export interface DragLayerProps {
  /** The board being rendered — used to resolve a dragged id back to its entry. */
  readonly board: Board;
  /** Called when a drag begins, with the item's id. `Board.tsx` folds this into `dragStarted`. */
  readonly onDragStart: (itemId: string) => void;
  /** Called as the pointer or the keyboard moves over a column. */
  readonly onDragOver: (column: BoardColumnId) => void;
  /** Called when the drag ends without a drop — folds into `dragEnded`. */
  readonly onDragCancel: () => void;
  /** Called when a card is dropped on a column — the same handler the native drop calls. */
  readonly onDrop: (column: BoardColumnId) => void;
  /** True when the reader asked for reduced motion. */
  readonly reducedMotion?: boolean;
  readonly children: ReactNode;
}

/**
 * Wraps the board in a `DndContext` and renders the dragged card's overlay.
 *
 * The activation constraint is the detail that makes this coexist with the
 * card's title link: a card's title is a real `<Link>`, and a pointer
 * sensor that activated on `pointerdown` would swallow the click and make
 * the title unopenable. Requiring a few pixels of movement first means a
 * click is still a click and a drag is still a drag.
 */
export function DragLayer({
  board,
  onDragStart,
  onDragOver,
  onDragCancel,
  onDrop,
  reducedMotion,
  children,
}: DragLayerProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  /**
   * Where the active card started, so a cancellation can say where it went
   * back to. Held in a ref rather than state: it is read inside handlers,
   * never during render, and putting it in state would re-render the whole
   * board on pick-up for a value nothing displays.
   */
  const sourceColumn = useRef<BoardColumnId | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // **8px before a drag starts.** Below this, a card's title link
      // becomes unclickable — the sensor claims the pointer on `pointerdown`
      // and the click never reaches the anchor. It is also what stops a
      // slightly unsteady click on a touchpad registering as a drag.
      activationConstraint: { distance: 8 },
    }),
    // T6-B: the same moves, from the keyboard alone. This sensor is what
    // turns the board's primary action from mouse-only into something
    // reachable without a pointer at all.
    useSensor(KeyboardSensor),
  );

  const activeEntry: BoardEntry | null = useMemo(
    () => (activeId === null ? null : findEntry(board, activeId)),
    [board, activeId],
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const itemId = String(event.active.id);
      const entry = findEntry(board, itemId);
      setActiveId(itemId);
      sourceColumn.current = entry?.column ?? null;
      if (entry !== null) {
        setAnnouncement(pickedUpMessage(primaryLine(entry.item), entry.column));
      }
      onDragStart(itemId);
    },
    [board, onDragStart],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      const over = event.over?.id;
      if (!isBoardColumn(over)) return;
      onDragOver(over);
      const entry = activeId === null ? null : findEntry(board, activeId);
      if (entry !== null) setAnnouncement(movedOverMessage(primaryLine(entry.item), over));
    },
    [activeId, board, onDragOver],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const itemId = String(event.active.id);
      const entry = findEntry(board, itemId);
      const title = entry === null ? "the item" : primaryLine(entry.item);
      const over = event.over?.id;
      setActiveId(null);

      // Dropped on nothing, or on a column that does not take drops — the
      // card goes back and the reader is told so, rather than the drag just
      // ending in silence.
      if (!isBoardColumn(over) || !isDropZone(over)) {
        setAnnouncement(cancelledMessage(title, sourceColumn.current));
        sourceColumn.current = null;
        onDragCancel();
        return;
      }

      setAnnouncement(droppedMessage(title, over));
      sourceColumn.current = null;
      // The SAME handler the native drop calls — `Board.tsx`'s `onDrop`,
      // which runs `handleDrop` against the extracted seam. The optimistic
      // move, the sequence number, the revert and the refusal message are
      // all that path's, unchanged by this row.
      onDrop(over);
    },
    [board, onDragCancel, onDrop],
  );

  const handleDragCancel = useCallback(() => {
    const entry = activeId === null ? null : findEntry(board, activeId);
    const title = entry === null ? "the item" : primaryLine(entry.item);
    setActiveId(null);
    setAnnouncement(cancelledMessage(title, sourceColumn.current));
    sourceColumn.current = null;
    onDragCancel();
  }, [activeId, board, onDragCancel]);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      // The library ships its own screen-reader announcements. They are
      // suppressed in favour of the live region below because the default
      // wording is generic ("draggable item 3 was moved over droppable area
      // 2") and this board can say the card's title and the column's name.
      accessibility={{ announcements: undefined }}
    >
      {children}
      {/* Portalled out of the columns' `overflow` troughs — a card dragged
          out of a bounded column would otherwise be clipped at its edge. */}
      <DragOverlay
        // The settle animation, and the one place reduced motion turns it
        // off outright rather than shortening it.
        dropAnimation={reducedMotion === true ? null : undefined}
      >
        <DragCardPreview entry={activeEntry} reducedMotion={reducedMotion} />
      </DragOverlay>
      {/* The successful path's announcement. `BoardView`'s `role="alert"`
          covers a refusal; this covers pick up, move and drop, which is what
          makes the keyboard path (T6-B) usable rather than silent. `polite`,
          not `assertive`: these are a running commentary on a gesture the
          reader is making, so they must not interrupt. */}
      <p role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </p>
    </DndContext>
  );
}
