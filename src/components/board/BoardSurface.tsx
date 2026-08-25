"use client";

// Which shape the board is drawn in — the kanban or the list (MILESTONES.md
// T6 §3).
//
// **The choice is read from the URL, not held in state.** That is the same
// contract the filters keep (`@/lib/board/filters`: "the URL is the state,
// not a copy of it"), and extending it to the layout is what makes the two
// acceptance criteria true at once: a list view can be linked and reloaded
// because its address says `layout=list`, and toggling layouts preserves
// the filters because both layouts read the same query string through the
// same parser.
//
// **Why a switch here rather than a prop on one component.** The two
// layouts share their data and their filters but almost none of their
// rendering — a table row and a draggable card have different structure,
// different density and different interactions. One component branching
// between them internally would be two components sharing a name, and the
// kanban's drag wiring would be carried on every list render.
//
// The filter bar is deliberately OUTSIDE the switch: it is the same bar in
// both layouts, and re-mounting it on every toggle would drop the reader's
// search draft and close the "more filters" picker for no reason.
import { useSearchParams } from "next/navigation";
import { layoutOf, parseBoardQuery } from "@/lib/board/filters";
import { Board } from "./Board";
import { ListViewContainer } from "./ListViewContainer";

export function BoardSurface() {
  const searchParams = useSearchParams();
  const layout = layoutOf(parseBoardQuery(searchParams.toString()));

  // `Board` renders its own filter bar, so the kanban path is exactly what
  // it was before this switch existed — an unchanged component at an
  // unchanged address. Only the list path is new.
  return layout === "list" ? <ListViewContainer /> : <Board />;
}
