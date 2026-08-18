// The shape half of a state chip — the channel that survives when colour
// does not (WCAG 1.4.1; `src/lib/design/tokens.ts` explains why this
// product needs it more than most).
//
// Hand-drawn SVG rather than `lucide-react`, for one reason that turned out
// to decide it: at 10px, the thing that distinguishes two icons is their
// SILHOUETTE, and a general-purpose icon set is drawn for 20–24px where
// interior detail is legible. Lucide's `circle-pause` and `circle-play`
// differ only inside a shared ring; at chip size that ring is most of the
// ink and the two are the same blob. These are drawn as bare shapes — a
// triangle, two bars, a tick — so the outline itself is the difference.
//
// `lucide-react` is still a dependency and is the right choice for
// navigation and action icons at ordinary sizes. It is simply the wrong
// tool for a 10px semantic marker.
//
// Hook-free and prop-driven like every other component here, so a test can
// call it as a function and inspect the tree (`tests/helpers/react-element.ts`).
import type { StateShape } from "@/lib/design/tokens";
import styles from "./Chips.module.css";

export interface StateIconProps {
  readonly shape: StateShape;
  /**
   * The colour to paint it. Passed in rather than read from the state, so
   * this component knows nothing about `ItemState` and can be reused for
   * any shape the design system grows.
   */
  readonly colour: string;
}

/**
 * Renders `shape` as a 10×10 SVG.
 *
 * `aria-hidden` throughout: the chip that wraps this always carries the
 * state's name as text or as an `aria-label`, so announcing the icon too
 * would read the state twice. The icon is a visual channel, not a semantic
 * one — the semantics are the label's job.
 */
export function StateIcon({ shape, colour }: StateIconProps) {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 10 10"
      aria-hidden="true"
      focusable="false"
      data-shape={shape}
    >
      {paths(shape, colour)}
    </svg>
  );
}

/**
 * The geometry for each shape.
 *
 * Every shape is drawn inside the same 10×10 box and sized to roughly the
 * same optical weight, so a row of mixed chips does not have one state
 * looking bolder than another for reasons that carry no meaning.
 */
function paths(shape: StateShape, colour: string) {
  switch (shape) {
    // An open ring — "there is a slot here, nothing is in it".
    case "dot":
      return <circle cx="5" cy="5" r="3.2" fill="none" stroke={colour} strokeWidth="1.6" />;
    // The same ring, filled — queued and ready, one step more committed.
    case "dot-filled":
      return <circle cx="5" cy="5" r="3.6" fill={colour} />;
    // A diagonal stroke with a nib — writing.
    case "pencil":
      return (
        <path d="M1.6 8.4 L2.2 6.4 L6.9 1.7 L8.3 3.1 L3.6 7.8 Z" fill={colour} stroke="none" />
      );
    // An eye's lens — something is being looked at.
    case "eye":
      return (
        <>
          <path
            d="M0.8 5 C2.6 2.2, 7.4 2.2, 9.2 5 C7.4 7.8, 2.6 7.8, 0.8 5 Z"
            fill="none"
            stroke={colour}
            strokeWidth="1.2"
          />
          <circle cx="5" cy="5" r="1.4" fill={colour} />
        </>
      );
    // A page with a tick on it — a plan waiting to be signed off. Shares
    // no outline with `eye`, which is the point: the two "someone is
    // looking at this" states must not collapse into one silhouette, and
    // their colours are two violets a reader cannot tell apart.
    case "stamp":
      return (
        <>
          <path
            d="M2 1.4 H6.4 L8.4 3.4 V8.6 H2 Z"
            fill="none"
            stroke={colour}
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M3.6 5.6 L4.8 6.8 L7 4.2"
            fill="none"
            stroke={colour}
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    // A triangle pointing right — running.
    case "play":
      return <path d="M2.4 1.4 L8.6 5 L2.4 8.6 Z" fill={colour} />;
    // Two bars. Maximally unlike the alert triangle it shares a column
    // with, which is the point — see STATE_SHAPES.
    case "pause":
      return (
        <>
          <rect x="2.2" y="1.6" width="2" height="6.8" rx="0.6" fill={colour} />
          <rect x="5.8" y="1.6" width="2" height="6.8" rx="0.6" fill={colour} />
        </>
      );
    // A warning triangle — the one shape in the set with a flat base and a
    // point at the top, so it is unmistakable in silhouette.
    case "alert":
      return (
        <>
          <path d="M5 0.9 L9.6 8.9 L0.4 8.9 Z" fill={colour} />
          {/* Punched out rather than drawn in a second colour: a light
              stroke over the fill would need to know what is behind the
              chip, and a chip sits on several different surfaces. */}
          <rect x="4.4" y="3.4" width="1.2" height="2.6" rx="0.5" fill="var(--surface-card)" />
          <rect x="4.4" y="6.6" width="1.2" height="1.2" rx="0.5" fill="var(--surface-card)" />
        </>
      );
    // A tick — done, and done well.
    case "check":
      return (
        <path
          d="M1.4 5.2 L3.9 7.7 L8.6 2.4"
          fill="none"
          stroke={colour}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    // Stacked lines — a document. Finished as knowledge, not as shipped code.
    case "book":
      return (
        <>
          <rect
            x="1.4"
            y="1.4"
            width="7.2"
            height="7.2"
            rx="1.2"
            fill="none"
            stroke={colour}
            strokeWidth="1.2"
          />
          <rect x="3.2" y="3.6" width="3.6" height="1" rx="0.5" fill={colour} />
          <rect x="3.2" y="5.6" width="3.6" height="1" rx="0.5" fill={colour} />
        </>
      );
    // A circle with a bar through it — closed without being done. NOT a
    // cross: a cross reads as failure, and `cancelled` is a decision.
    case "slash":
      return (
        <>
          <circle cx="5" cy="5" r="3.6" fill="none" stroke={colour} strokeWidth="1.3" />
          <path d="M2.5 7.5 L7.5 2.5" stroke={colour} strokeWidth="1.3" strokeLinecap="round" />
        </>
      );
  }
}
