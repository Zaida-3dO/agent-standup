// A state, rendered — the OUTLINED half of the state/priority pair.
//
// Outlined, and priority is filled. See `Chips.module.css`: the two sit in
// the same corner of a card, so the difference between them has to be
// something the eye sorts before it reads, or they collapse into one
// vocabulary. Fill is such a property; colour alone is not.
//
// Hook-free and prop-driven, so a test calls it as a function and inspects
// the element tree — `tests/helpers/react-element.ts`, and `TopBar.tsx`'s
// header for the full reasoning.
import type { ItemState } from "@/lib/board/types";
import { STATE_LABELS, STATE_SHAPES, stateTokens } from "@/lib/design/tokens";
import { StateIcon } from "./StateIcon";
import styles from "./Chips.module.css";

export interface StateChipProps {
  readonly state: ItemState;
  /**
   * Drop the text label, leaving only the icon.
   *
   * For genuinely space-constrained rows (a mini-board, a dense table).
   * The chip keeps an `aria-label` carrying the full state name, so the
   * information is lost only visually — and the icon is chosen so it is not
   * lost even there.
   */
  readonly iconOnly?: boolean;
}

/**
 * The chip.
 *
 * Colour comes from the state's triplet and never from a literal, so a
 * state that is amber here is amber everywhere — including on a card's left
 * border and in a filter menu, which are painted from the same three custom
 * properties.
 */
export function StateChip({ state, iconOnly }: StateChipProps) {
  const tokens = stateTokens(state);
  const label = STATE_LABELS[state];

  return (
    <span
      className={`${styles.chip} ${styles.outlined}${iconOnly ? ` ${styles.iconOnly}` : ""}`}
      style={{ color: tokens.fg, borderColor: tokens.border }}
      data-state={state}
      data-variant="outlined"
      // Always present, not only when the label is hidden. A sighted reader
      // sees "Executing"; a screen reader with the label visible would
      // otherwise announce the bare word with no indication it is a status,
      // and with `iconOnly` would announce nothing at all.
      aria-label={`State: ${label}`}
      title={label}
    >
      <StateIcon shape={STATE_SHAPES[state]} colour={tokens.fg} />
      {/* `aria-hidden` because the `aria-label` above already names it —
          without this the state is announced twice. */}
      {!iconOnly && <span aria-hidden="true">{label}</span>}
    </span>
  );
}
