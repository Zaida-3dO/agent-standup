// Whether an agent holding an item is still alive — green running, amber
// stalled, grey dead.
//
// `dead` is a hollow ring rather than a filled grey disc. Two reasons, and
// the second is the real one: a solid grey dot at 8px is hard to
// distinguish from a bullet or a rendering artefact, and — more
// importantly — an absent agent should read as an EMPTY SLOT rather than as
// a present-but-quiet one. A dead claim is a hole in the fleet, and the
// shape says so.
//
// Grey and not red, deliberately: a dead agent is an absence, not an error.
// Red is reserved for `blocked`, which is something a person must act on.
//
// Hook-free and prop-driven — `tests/helpers/react-element.ts`.
import { presenceToken, type Liveness } from "@/lib/design/tokens";
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
  live: "running",
  stalled: "stalled",
  dead: "dead",
};

export function AgentPresenceDot({ liveness, agentName }: AgentPresenceDotProps) {
  const word = LIVENESS_LABELS[liveness];
  const label = agentName === undefined ? `Agent is ${word}` : `${agentName} is ${word}`;
  // `dead` takes its colour from the border rather than the background, so
  // the inline style must not paint a fill over the hollow ring.
  const isDead = liveness === "dead";

  return (
    <span
      className={`${styles.presenceDot}${isDead ? ` ${styles.presenceDead}` : ""}`}
      style={isDead ? undefined : { background: presenceToken(liveness) }}
      data-liveness={liveness}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
