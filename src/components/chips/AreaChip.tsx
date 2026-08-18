// An area, rendered. Colour is derived from the name — see
// `src/lib/design/area-colour.ts` for why it is hashed rather than mapped.
//
// Outlined rather than filled: an area is context, not urgency, and giving
// it a priority chip's weight would put twelve competing fills on a board
// whose actual signal is the two-or-three P0s.
//
// Hook-free and prop-driven — `tests/helpers/react-element.ts`.
import { areaColour } from "@/lib/design/area-colour";
import styles from "./Chips.module.css";

export interface AreaChipProps {
  readonly area: string;
}

export function AreaChip({ area }: AreaChipProps) {
  const colour = areaColour(area);

  return (
    <span
      className={`${styles.chip} ${styles.outlined}`}
      style={{ color: colour.fg, borderColor: colour.border }}
      data-area={area}
      data-variant="outlined"
      aria-label={`Area: ${area}`}
    >
      {/* The name always renders. The hue has twelve buckets and areas are
          unbounded, so two areas WILL eventually share a colour — the text
          is what actually identifies it, and the colour only helps you find
          it again. */}
      <span aria-hidden="true">{area}</span>
    </span>
  );
}
