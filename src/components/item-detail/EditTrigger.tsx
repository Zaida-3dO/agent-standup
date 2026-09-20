// The button that opens an in-place editor — and, just as importantly, the
// button that takes focus BACK when that editor closes
// (docs/DESIGN-LANGUAGE.md §6: "focus returns to the trigger on exit").
//
// **Why this is its own component rather than a hook in each parent.**
// The return-focus move needs a `useRef` + `useEffect` pair, and the three
// places that render a trigger — `ItemDetailView` (title), `StatusBlock`
// (priority, area) and `InlineEditField` (headline) — are all deliberately
// HOOK-FREE. That is not an accident of style: this repo's tests call those
// components as plain functions and walk the returned element tree, with no
// DOM and no renderer (`vitest.config.ts` sets `environment: "node"`; see
// `tests/helpers/react-element.ts`). A hook anywhere in them throws
// "Invalid hook call" the moment a test calls them, which is what happened
// on the first attempt at this fix — 39 tests across
// `tests/item-detail-status-block.test.ts` failed at once.
//
// Pushing the hooks down into a leaf keeps both properties: the parents
// stay directly callable, and this component is exercised where hooks are
// legal, in the jsdom wiring tests that mount real React.
//
// It renders the same markup the three call sites rendered inline before,
// including the two different looks a trigger has — see `variant`.
import type { ReactNode, Ref } from "react";
import { useEffect, useRef } from "react";
import type { EditableField, EditingField } from "@/lib/item-detail/edit-state";
import styles from "./ItemDetail.module.css";

export interface EditTriggerProps {
  /** Which field this trigger opens — matched against `returnFocusTo` to decide whether a just-ended edit was this one's. */
  readonly field: EditableField;
  /** The full accessible name, e.g. `"Priority: P0 — activate to edit"` — never a bare value, per §6. */
  readonly label: string;
  readonly onActivate: () => void;
  /**
   * `"value"` wraps the value itself and IS the control (title, headline).
   * `"affordance"` is the standalone pencil used where the value is already
   * a link and so cannot carry a second primary action (priority, area).
   */
  readonly variant: "value" | "affordance";
  /** The field whose edit just ended — see `ItemEditProps.returnFocusTo`. */
  readonly returnFocusTo?: EditingField;
  readonly onFocusReturned?: () => void;
  readonly children: ReactNode;
}

export function EditTrigger({
  field,
  label,
  onActivate,
  variant,
  returnFocusTo,
  onFocusReturned,
  children,
}: EditTriggerProps) {
  const ref = useRef<HTMLButtonElement | null>(null);

  // Is the edit that just ended the one THIS trigger opened? With four
  // triggers on the page sharing one edit slot, a bare "an edit ended"
  // signal would be ambiguous between all four, and closing the priority
  // editor would pull focus to whichever trigger rendered first.
  const mine = returnFocusTo === field;

  useEffect(() => {
    if (!mine) return;
    ref.current?.focus();
    // Clear the signal, so this fires once. Left set, it would re-run on
    // every later re-render of the page — a history page-in, a poll — and
    // drag focus back here from wherever the reader had since moved it.
    onFocusReturned?.();
  }, [mine, onFocusReturned]);

  return (
    <button
      type="button"
      ref={ref as Ref<HTMLButtonElement>}
      className={variant === "value" ? styles.editable : styles.editAffordance}
      aria-label={label}
      onClick={onActivate}
    >
      {children}
    </button>
  );
}
