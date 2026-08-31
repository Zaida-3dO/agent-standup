// The crew digest — the third part of MILESTONES.md #64, specified in
// DECISIONS.md §6 ("The digest is computed, not investigated").
//
// **A briefing, not an alert.** §6 is explicit and the distinction is the
// whole design: the server surfaces what it can compute, and the
// orchestrator judges direction. The reason it stops there is stated in the
// same section as an honest limit — *"pursuing a plausible but wrong
// approach"* is not computable, because an agent can be productive, varied,
// on-path and completely wrong. So nothing here concludes that a crewmate
// is in trouble. It reports what is measurable and leaves the judgement
// where the judgement can actually be made.
//
// That is also why every anomaly below carries the numbers it was derived
// from rather than only a verdict. An orchestrator reading "elevated" with
// no figure cannot tell a marginal case from a stark one, and would have to
// go and look — which is exactly the hunting §6 says the digest exists to
// replace.
//
// **Composed, not recomputed.** The signals come from `readSessionShape`
// (#54, `@/lib/telemetry/shape.ts`) and from the assignments the liveness
// ladder already maintains (#24). This module folds them into one reading
// per crewmate and adds nothing of its own that those two do not already
// measure — a second implementation of "how many repeats" would be a second
// answer to drift from the first.
import type { SessionShape } from "@/lib/telemetry/shape";

/**
 * One computable observation about a crewmate, with the evidence attached.
 *
 * `kind` is a stable identifier so a consumer can act on one without
 * matching on prose; `detail` is the human line. Both, because the two
 * audiences are a program and a reader and neither is well served by the
 * other's form.
 */
export interface CrewAnomaly {
  readonly kind:
    | "repeated-commands"
    | "narrow-spread"
    | "reading-not-writing"
    | "no-checkpoint"
    | "outside-declared-area";
  readonly detail: string;
}

/** What one crewmate's line in the briefing says. */
export interface CrewMemberDigest {
  readonly sessionId: string;
  readonly agent: string | null;
  /** The item this crewmate holds, when it holds one. */
  readonly itemId: string | null;
  /** How many tool calls the reading was taken over — zero when nothing has been reported. */
  readonly calls: number;
  /** The crewmate's own latest checkpoint headline, when there is one. */
  readonly latestCheckpoint: string | null;
  /** Minutes since that checkpoint, or since the claim when there is none. */
  readonly minutesSinceCheckpoint: number | null;
  readonly anomalies: readonly CrewAnomaly[];
}

/** The whole briefing. */
export interface CrewDigest {
  readonly members: readonly CrewMemberDigest[];
  /** Crewmates with at least one anomaly, so a reader can start there. */
  readonly flagged: number;
}

/**
 * How long a crewmate may go without a checkpoint before the digest says so.
 *
 * A default rather than a setting for now: §6 lists *"no checkpoint in N
 * minutes"* among the computable anomalies without fixing N, and inventing
 * a settings key for it would commit a name and a scope
 * (`crew.checkpoint_silence_minutes`? per-machine? per-item?) that no row
 * has asked for. The constant is exported so a caller may override it, and
 * promoting it to a real setting is a one-line change when a row wants one.
 */
export const DEFAULT_CHECKPOINT_SILENCE_MINUTES = 20;

/** What the digest is computed from, for one crewmate. */
export interface CrewMemberInput {
  readonly sessionId: string;
  readonly agent: string | null;
  readonly itemId: string | null;
  /** `readSessionShape`'s output (#54), or null when the session has reported no calls. */
  readonly shape: SessionShape | null;
  readonly latestCheckpoint: string | null;
  readonly minutesSinceCheckpoint: number | null;
  /**
   * Paths this session touched that fall outside its item's declared area or
   * repo. §6 calls this anomaly *"exact, strong"* — unlike the others it is
   * not a threshold judgement, so it is passed in already determined rather
   * than guessed at here.
   */
  readonly pathsOutsideDeclaredArea?: readonly string[];
}

/**
 * The anomalies computable for one crewmate.
 *
 * **`unknown` never produces an anomaly.** `readSessionShape` answers
 * `unknown` below its minimum sample precisely so that a consumer does not
 * treat too-little-evidence as a finding, and a digest that flagged it would
 * flag every crewmate for its first few tool calls — making the flag
 * meaningless exactly when a new session most needs a clean reading. Only
 * `elevated` is reported.
 */
export function anomaliesFor(
  member: CrewMemberInput,
  silenceMinutes: number = DEFAULT_CHECKPOINT_SILENCE_MINUTES,
): readonly CrewAnomaly[] {
  const anomalies: CrewAnomaly[] = [];
  const shape = member.shape;

  if (shape?.repeats.level === "elevated") {
    anomalies.push({
      kind: "repeated-commands",
      detail: `Returned to the same command ${shape.repeats.value} times across ${shape.repeats.sampleSize} calls.`,
    });
  }

  if (shape?.spread.level === "elevated") {
    anomalies.push({
      kind: "narrow-spread",
      detail: `Touched ${shape.spread.value} distinct paths across ${shape.spread.sampleSize} calls.`,
    });
  }

  if (shape?.readShare.level === "elevated") {
    anomalies.push({
      kind: "reading-not-writing",
      detail: `${shape.readShare.value}% of classifiable calls were reads, across ${shape.readShare.sampleSize} calls.`,
    });
  }

  // Silence is measured against the checkpoint when there is one and against
  // the claim when there is not — the caller resolves which, because "how
  // long has this been quiet" has the same meaning either way and a digest
  // that reported them differently would bury the more urgent case (a
  // crewmate that has never checkpointed at all).
  if (member.minutesSinceCheckpoint !== null && member.minutesSinceCheckpoint >= silenceMinutes) {
    anomalies.push({
      kind: "no-checkpoint",
      detail:
        member.latestCheckpoint === null
          ? `No checkpoint yet, ${member.minutesSinceCheckpoint} minutes in.`
          : `No checkpoint for ${member.minutesSinceCheckpoint} minutes.`,
    });
  }

  const outside = member.pathsOutsideDeclaredArea ?? [];
  if (outside.length > 0) {
    // Bounded: a session that wandered widely would otherwise put its whole
    // path list into a briefing that is meant to be read at a glance.
    const shown = outside.slice(0, 3).join(", ");
    const rest = outside.length > 3 ? `, and ${outside.length - 3} more` : "";
    anomalies.push({
      kind: "outside-declared-area",
      detail: `Worked outside the item's declared area or repo: ${shown}${rest}.`,
    });
  }

  return anomalies;
}

/**
 * The briefing for a whole crew.
 *
 * Ordered with the flagged crewmates first, then by how long they have been
 * quiet. A digest exists to be read quickly, and the ordering is the
 * cheapest way to make the first line the one most worth reading — where
 * sorting by session id would put the interesting crewmate anywhere.
 */
export function composeCrewDigest(
  members: readonly CrewMemberInput[],
  silenceMinutes: number = DEFAULT_CHECKPOINT_SILENCE_MINUTES,
): CrewDigest {
  const digested = members.map((member) => ({
    sessionId: member.sessionId,
    agent: member.agent,
    itemId: member.itemId,
    calls: member.shape?.calls ?? 0,
    latestCheckpoint: member.latestCheckpoint,
    minutesSinceCheckpoint: member.minutesSinceCheckpoint,
    anomalies: anomaliesFor(member, silenceMinutes),
  }));

  const ordered = [...digested].sort((a, b) => {
    if (a.anomalies.length !== b.anomalies.length) return b.anomalies.length - a.anomalies.length;
    return (b.minutesSinceCheckpoint ?? -1) - (a.minutesSinceCheckpoint ?? -1);
  });

  return {
    members: ordered,
    flagged: ordered.filter((member) => member.anomalies.length > 0).length,
  };
}
