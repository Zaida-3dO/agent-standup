// The status picker — MILESTONES.md #76's "a list with a status picker
// instead of drag".
//
// Hook-free and prop-driven, like `ListView` and `BoardFilterBarView`, so
// a test calls it as a function and inspects the returned tree
// (`tests/helpers/react-element.ts`). The container owns the request; this
// decides only what is offered and how it reads.
//
// **A native `<select>`, deliberately.** On a phone this opens the
// platform's own picker — a full-width wheel or list, already thumb-sized,
// already scrollable, already dismissable the way every other app on the
// device does it. A custom listbox would have to reimplement all of that
// and would land smaller. It is also the control this codebase already
// uses for choosing one of a short list (`BoardFilterBarView`'s
// `AxisSelect`), so it inherits the same keyboard and screen-reader
// behaviour rather than a second set of semantics.
//
// **The options come from `@/lib/board/status-picker`, which derives them
// from the drag's own `TARGET_STATE`.** Nothing here decides what is
// legal — see that module's header for why the picker must not grow a
// second legality model.
import { statusChoices, statusPickerLabel, readOnlyStatusLabel } from "@/lib/board/status-picker";
import type { BoardColumnId, BoardEntry } from "@/lib/board/types";
import styles from "./StatusPicker.module.css";

export interface StatusPickerProps {
  readonly entry: BoardEntry;
  /** Issued only for a real move — the container turns this into a transition. */
  readonly onPick: (itemId: string, column: BoardColumnId) => void;
  /** True while this row's move is in flight; the control is disabled so a second pick cannot race it. */
  readonly pending?: boolean;
}

export function StatusPicker({ entry, onPick, pending = false }: StatusPickerProps) {
  const choices = statusChoices(entry);

  // A project has no choices (`statusChoices` returns none) because it has
  // no state of its own to transition. It still has to SAY where it is, so
  // the cell renders the status as text rather than as a control that
  // could only ever be refused — the same decision `ListView` makes for a
  // project's checkbox cell and its state chip.
  if (choices.length === 0) {
    return <span className={styles.readOnly}>{readOnlyStatusLabel(entry.item.state)}</span>;
  }

  const current = choices.find((choice) => choice.current);

  return (
    <select
      className={styles.picker}
      // Named for the row, not just "Status" — a screen-reader user moving
      // down forty rows otherwise hears the same word forty times with no
      // way to tell which row has focus.
      aria-label={statusPickerLabel(entry.item.title)}
      // `""` when the item's current column is not among the choices —
      // which is exactly the Waiting case, since Waiting cannot be a
      // target. A blocked item must not render as though it were in
      // Backlog, so the control shows the empty option describing where it
      // actually is instead of silently selecting the first entry, which
      // is what a `<select>` does with a value it does not hold.
      value={current?.column ?? ""}
      disabled={pending}
      data-pending={pending ? "true" : undefined}
      data-testid={`status-picker-${entry.item.id}`}
      onChange={(event) => {
        const column = event.target.value;
        // The placeholder is not a destination. Choosing it would be
        // asking to move the item to Waiting, which no picker can express
        // (both waiting states need a reason), so it is ignored rather
        // than sent and refused.
        if (column === "") return;
        onPick(entry.item.id, column as BoardColumnId);
      }}
    >
      {/* Rendered ONLY for an item whose column is unreachable — an item
          already in one of the offered columns has a real option selected
          and needs no placeholder. Without this an item in Waiting would
          have no option matching its value. */}
      {current === undefined && <option value="">{readOnlyStatusLabel(entry.item.state)}</option>}
      {choices.map((choice) => (
        <option key={choice.column} value={choice.column}>
          {choice.label}
        </option>
      ))}
    </select>
  );
}
