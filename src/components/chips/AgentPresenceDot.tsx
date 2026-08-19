// Whether an agent holding an item is still alive — green running, amber
// stalled, grey dead, or violet superseded.
//
// **Four values, four distinguishable renderings — none is a synonym for
// another** (see `Liveness` in `@/lib/board/types`). `dead` is a hollow ring
// rather than a filled grey disc: a solid grey dot at 8px is hard to
// distinguish from a bullet, and — more importantly — an absent agent
// should read as an EMPTY SLOT rather than as a present-but-quiet one. A
// dead claim is a hole in the fleet, and the shape says so.
//
// `superseded` is filled, unlike `dead` — a takeover is a deliberate
// handover, not an absence — but rings itself in a contrasting halo so it
// is not mistaken for a plain `running`/`stalled` dot. Folding it into
// `dead` would report a normal handover as a failure; folding it into
// `stalled` would claim the superseded session might still come back, which
// SCHEMA.md §2 says it explicitly cannot.
//
// Grey and not red for `dead`, deliberately: a dead agent is an absence,
// not an error. Red is reserved for `blocked`, which is something a person
// must act on.
//
// Hook-free and prop-driven — `tests/helpers/react-element.ts`.
import type { Liveness } from "@/lib/board/types";
import { presenceToken } from "@/lib/design/tokens";
import styles from "./Chips.module.css";

export interface AgentPresenceDotProps {
  readonly liveness: Liveness;
  /**
   * The agent's name, for the accessible label.
   *
   * Optional because a fleet table's row already names the agent in the
   * adjacent cell, and repeating it in the dot's label would make a screen
   * reader announce the name twice per row.
   */
  readonly agentName?: string;
}

/** What each liveness value means in words — the non-colour channel. */
const LIVENESS_LABELS: Record<Liveness, string> = {
  running: "running",
  stalled: "stalled",
  dead: "dead",
  superseded: "superseded",
};

export function AgentPresenceDot({ liveness, agentName }: AgentPresenceDotProps) {
  const word = LIVENESS_LABELS[liveness];
  const label = agentName === undefined ? `Agent is ${word}` : `${agentName} is ${word}`;
  // `dead` takes its colour from the border rather than the background, so
  // the inline style must not paint a fill over the hollow ring.
  const isDead = liveness === "dead";
  // `superseded` takes its colour from the halo (`box-shadow`) rather than
  // the background fill, which stays the dead-neutral surface colour set in
  // CSS — see `.presenceSuperseded`.
  const isSuperseded = liveness === "superseded";

  let variantClass = "";
  if (isDead) variantClass = ` ${styles.presenceDead}`;
  else if (isSuperseded) variantClass = ` ${styles.presenceSuperseded}`;

  return (
    <span
      className={`${styles.presenceDot}${variantClass}`}
      style={isDead || isSuperseded ? undefined : { background: presenceToken(liveness) }}
      data-liveness={liveness}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
