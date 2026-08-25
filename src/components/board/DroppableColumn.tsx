"use client";

// The hook-holding shim between `dnd-kit` and the hook-free `BoardColumn` —
// the drop side of what `DraggableCard` does for the drag side.
//
// `useDroppable` is called here; `BoardColumn` receives a plain `dropRef`
// prop and stays a function a test can call directly. The column's existing
// native `onDragOver`/`onDrop` handlers are untouched and still fire for a
// browser drag.
import { useDroppable } from "@dnd-kit/core";
import { isDropZone } from "@/lib/board/drag-visual";
import { BoardColumn, type BoardColumnProps } from "./BoardColumn";
import { DraggableCard } from "./DraggableCard";

export type DroppableColumnProps = Omit<
  BoardColumnProps,
  "dropRef" | "showPlaceholder" | "cardComponent"
>;

/**
 * `BoardColumn` registered as a `dnd-kit` drop target.
 *
 * **Waiting is never registered** (`isDropZone` → `TARGET_STATE`): both its
 * states require fields a drag cannot supply, so it is not a target rather
 * than one that accepts the gesture and always refuses. Not registering it
 * is also what makes the keyboard sensor skip it when cycling columns,
 * which is the accessible equivalent of not highlighting it.
 */
export function DroppableColumn(props: DroppableColumnProps) {
  const droppable = isDropZone(props.column);
  const { setNodeRef, isOver } = useDroppable({
    id: props.column,
    disabled: !droppable,
  });

  // Waiting takes no drops, but its cards are still DRAGGABLE — an item can
  // be dragged OUT of Waiting even though nothing can be dropped INTO it.
  // Passing the wrapper here is what makes that true; withholding it would
  // strand every paused and blocked card as unmovable by pointer or keyboard.
  if (!droppable) return <BoardColumn {...props} cardComponent={DraggableCard} />;

  return (
    <BoardColumn
      {...props}
      dropRef={setNodeRef}
      cardComponent={DraggableCard}
      // The landing site. Driven by the library's own hit-testing rather
      // than the native `onDragEnter`, so it tracks the pointer accurately
      // during a real drag — and, because the keyboard sensor drives `isOver`
      // too, the same placeholder appears for a keyboard move (T6-B).
      showPlaceholder={isOver}
      isDropTarget={props.isDropTarget === true || isOver}
    />
  );
}
