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
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  // The library's own announcement contract. `silentAnnouncements` below is
  // typed against it — its handlers declare `string | undefined`, which is
  // what makes returning `undefined` a supported "say nothing" rather than a
  // trick, and typing the constant means an edit that returns a string is
  // caught here instead of on a screen reader.
  type Announcements,
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
import { horizontalStep, VERTICAL_STEP_PX } from "@/lib/board/drag-keyboard";
import { DragCardPreview } from "./DragCardPreview";
import styles from "./Board.module.css";

/**
 * A whole column per left/right press, instead of the library's 25px.
 *
 * The defect (`@/lib/board/drag-keyboard` states it in full): with no
 * `coordinateGetter`, `KeyboardSensor` moves 25px per press, so crossing
 * one of this board's columns took about twelve presses.
 *
 * The step is MEASURED rather than assumed, from the collision rects the
 * sensor is already given — the columns are `repeat(4, minmax(0, 1fr))`, so
 * whichever droppable is under the drag measures the pitch for all of them,
 * and a measured step keeps working when the viewport changes the column
 * width (including at the 900px and 560px reflows, where the grid drops to
 * two columns and then one). `horizontalStep`'s fallback covers the case
 * where nothing has been measured yet.
 */
const boardCoordinateGetter: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates, context },
) => {
  const width = context.collisionRect?.width;
  // The gap between columns, from the same `1rem` the grid declares. Read
  // as a number here rather than from the stylesheet because the sensor has
  // no element to resolve a custom property against.
  const step = horizontalStep(typeof width === "number" ? width : Number.NaN, 16);
  switch (event.code) {
    case KeyboardCode.Right:
      return { ...currentCoordinates, x: currentCoordinates.x + step };
    case KeyboardCode.Left:
      return { ...currentCoordinates, x: currentCoordinates.x - step };
    case KeyboardCode.Down:
      return { ...currentCoordinates, y: currentCoordinates.y + VERTICAL_STEP_PX };
    case KeyboardCode.Up:
      return { ...currentCoordinates, y: currentCoordinates.y - VERTICAL_STEP_PX };
    default:
      return undefined;
  }
};

/** True when an id is one of the board's columns — a drop can land anywhere, so this is checked. */
function isBoardColumn(id: unknown): id is BoardColumnId {
  return typeof id === "string" && (BOARD_COLUMNS as readonly string[]).includes(id);
}

/**
 * Announcements that say nothing, so this board has exactly one announcer.
 *
 * Every handler returns `undefined`, which `dnd-kit`'s `announce` treats as
 * "no announcement" and skips — leaving the library's `assertive` region
 * empty while the polite region in `DragLayer` does the talking. Supplying
 * silent announcements is the only lever the library offers for this — it
 * has no prop that removes the region itself.
 */
const silentAnnouncements: Announcements = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

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
    // reachable without a pointer at all — and the coordinate getter is
    // what makes it usable rather than merely possible, at one column per
    // press instead of the library default's twelve presses per column.
    useSensor(KeyboardSensor, { coordinateGetter: boardCoordinateGetter }),
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
      // The library ships its own screen-reader announcements, and they are
      // replaced here by the live region below, which can say the card's
      // title and the column's name instead of an id.
      //
      // **`silentAnnouncements`, and NOT `{ announcements: undefined }`.**
      // That spelling reads as suppression and does the exact opposite:
      // the library destructures with a default
      // (`announcements = defaultAnnouncements`), and a property explicitly
      // set to `undefined` takes that default just as an absent one does.
      // So the defaults stayed on, and they are `assertive` and interpolate
      // `active.id` — meaning a screen reader read out a raw UUID
      // ("Picked up draggable item 4f8a…") and, being assertive, INTERRUPTED
      // the polite region below mid-sentence. Two announcers, and the one
      // that won was the unreadable one.
      //
      // Handlers returning `undefined` are the supported way to say
      // nothing: `useAnnouncement`'s `announce` ignores a nullish value, so
      // the library's region stays empty and only ours speaks.
      accessibility={{ announcements: silentAnnouncements }}
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
