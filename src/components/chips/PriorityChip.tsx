// A priority, rendered — the FILLED half of the state/priority pair.
//
// The fill is the whole design decision. Rendered as two pieces of small
// coloured text side by side, "P0" and "blocked" give a reader no way to
// tell that one is an urgency someone assigned and the other a status the
// system derived. Filled-vs-outlined separates them pre-attentively,
// survives greyscale, and survives colour blindness — none of which two
// shades of small text does.
//
// P2 and P3 are painted from neutral tokens on purpose: most items are P2,
// and a coloured default makes the board a wall of colour in which P0 stops
// meaning anything.
//
// Hook-free and prop-driven — `tests/helpers/react-element.ts`.
import { priorityTokens, type Priority } from "@/lib/design/tokens";
import styles from "./Chips.module.css";

export interface PriorityChipProps {
  readonly priority: Priority;
}

export function PriorityChip({ priority }: PriorityChipProps) {
  const tokens = priorityTokens(priority);

  return (
    <span
      className={`${styles.chip} ${styles.filled}`}
      style={{ color: tokens.fg, background: tokens.bg }}
      data-priority={priority}
      data-variant="filled"
      // "P0" alone is jargon to a screen reader; "Priority: P0" is not.
      aria-label={`Priority: ${priority}`}
      title={`Priority ${priority}`}
    >
      {/* `tabular` is the global utility from `globals.css`, not a module
          class — a count, an age and a priority must all align the same way
          across every surface, so it is defined once globally rather than
          re-declared in each module that needs it. */}
      <span className="tabular" aria-hidden="true">
        {priority}
      </span>
    </span>
  );
}
