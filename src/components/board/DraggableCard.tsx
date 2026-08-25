"use client";

// The hook-holding shim between `dnd-kit` and the hook-free `ItemCard`.
//
// This is the whole trick that lets a hooks-first drag library coexist with
// a component the tests call as a plain function: `useDraggable` is called
// HERE, and everything it returns — the node ref, the ARIA attributes, the
// pointer/keyboard listeners — is handed to `ItemCard` as one ordinary prop
// (`dragHandle`). `ItemCard` never imports `dnd-kit`, never calls a hook,
// and is still constructed directly in `tests/board-drag-component.test.ts`
// with `dragHandle` simply absent.
//
// A card rendered WITHOUT this wrapper is still a working card with the
// native HTML5 drag on it — which is what `BoardColumn` falls back to when
// no drag is wired up at all.
import { useDraggable } from "@dnd-kit/core";

import { isDraggable } from "@/lib/board/drag";
import { ItemCard, type ItemCardProps } from "./ItemCard";

export type DraggableCardProps = Omit<ItemCardProps, "dragHandle">;

/**
 * `ItemCard` with a `dnd-kit` handle attached.
 *
 * **A project is not registered as draggable at all**, for the reason
 * `isDraggable` gives: its column derives from its children and it has no
 * state of its own to transition, so offering the gesture and refusing
 * every time would teach the wrong model. This mirrors the native path's
 * decision rather than restating it — both ask `isDraggable`.
 */
export function DraggableCard(props: DraggableCardProps) {
  const draggable = isDraggable(props.entry);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: props.entry.item.id,
    disabled: !draggable,
  });

  if (!draggable) return <ItemCard {...props} />;

  return (
    <ItemCard
      {...props}
      dragHandle={{
        ref: setNodeRef,
        // `listeners` is a plain object of event handlers and `attributes`
        // a plain object of ARIA/tabindex values — both are just props by
        // the time `ItemCard` sees them, which is what keeps that component
        // free of any knowledge of the library.
        listeners: listeners ?? {},
        // `DraggableAttributes` is a fixed-key interface with no index
        // signature, so it does not structurally satisfy the
        // `Record<string, unknown>` the card asks for. Spreading it into a
        // fresh object is the honest widening — the values are unchanged,
        // and it keeps `ItemCard` free of any type imported from the drag
        // library, which is the whole point of that prop being structural.
        attributes: { ...attributes },
        isDragging,
      }}
    />
  );
}
