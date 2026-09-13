// Deriving an intervention's score from what the session did next.
//
// `./scoring.ts` defines the scale and what scores add up to; `./survey.ts`
// asks a session to apply that scale by hand. This module is the third
// route, and it is the one that does not depend on anybody remembering:
// given a firing and the calls that followed it, it works out whether the
// session **took the advice or routed around it**, and turns that into a
// score on the same 1–5 scale.
//
// ── Why a derived score is possible at all here ────────────────────────
//
// Because the owner's scale is already written in behavioural terms. Read
// the two ends of `INTERVENTION_SCORE_MEANINGS` and they describe actions,
// not feelings:
//
//   1 — "a block I had to route around, a stumbling block that took too
//       long to work around"
//   5 — "I would have gone down the wrong path … if not for this nudge"
//
// "Routed around it" and "changed course" are observable. A session that
// was refused and then issued a materially identical call moments later
// did not take the advice — it re-ran the same thing, which is either an
// override or a retry that the guard failed to prevent. A session that was
// refused and then did something else took it. Neither reading requires
// asking anyone.
//
// ── What it deliberately cannot see, and why that caps the scale ───────
//
// It cannot see whether the advice was *correct* — only whether it was
// *followed*. Those come apart in one direction that matters: a session
// that complies with a wrong nudge looks identical to one that complies
// with a right one. So compliance is evidence the guard was not an
// obstacle; it is NOT evidence the guard saved anything.
//
// That asymmetry is why `MAX_DERIVED_SCORE` is 4 and not 5. A 5 in the
// owner's words is *"I would have gone down the wrong path … if not for
// this nudge"* — a counterfactual about what would have happened
// otherwise, and no observation of what did happen can establish one. Only
// a rater who knows what they were about to do can award a 5, so the
// derivation refuses to, and a 5 in the table always means a human or an
// agent said so.
//
// The floor is not capped in the same way, and the reason is worth stating
// because the asymmetry looks arbitrary. A 1's wording is entirely about
// observable friction — a block routed around, a workaround that took too
// long — so it is exactly the point on this scale that a behavioural
// reading CAN establish. The scale's top asks about a road not taken; its
// bottom asks about a road that was.
//
// ── It is a weaker rater, and it records itself as one ─────────────────
//
// A derived score is written with `raterType: "agent"` and a reserved
// rater id, so it never occupies the slot a real agent's own answer would
// take (`@@unique([eventId, raterType, raterId])` keeps the two rows apart)
// and every aggregate can tell them apart after the fact. This module does
// not do that writing — it holds no database client and returns a value —
// but the shape it returns is what makes that separation possible, and
// `DERIVED_RATER_ID` lives here so the reserved name and the reasoning for
// it stay together.
//
// ── This module writes nothing and reads no clock ──────────────────────
//
// Everything it needs arrives as an argument, including the timestamps, so
// every threshold in it can be tested by passing numbers rather than by
// waiting.

import {
  MAX_INTERVENTION_SCORE,
  MIN_INTERVENTION_SCORE,
  isValidInterventionScore,
} from "./scoring";

/**
 * The rater id every derived score is written under.
 *
 * Reserved rather than null. A null rater id collapses to the sentinel
 * `""` that an anonymous human answer also uses, and the two would then
 * contend for one row under the unique constraint — so a derivation could
 * silently overwrite a person's rating, which is the one direction this
 * must never fail in. A named id keeps derived and volunteered scores as
 * separate rows for the same firing, which is what lets an aggregate ask
 * whether they agree.
 */
export const DERIVED_RATER_ID = "derived";

/**
 * The highest score a derivation will award.
 *
 * Four, not five. See the header: a 5 asserts a counterfactual — that the
 * session was *about to* do something wrong — and no record of what the
 * session actually did can establish what it would otherwise have done. A
 * derivation that awarded 5s would put the scale's strongest claim in the
 * table without anyone having made it, and the aggregate that claim feeds
 * is the whole product of this system.
 */
export const MAX_DERIVED_SCORE = 4;

/**
 * How long after a firing a follow-up call still counts as a response to
 * it, in milliseconds.
 *
 * Three minutes. The question this window answers is "what did the session
 * do about the thing it was just told", and the honest bound on that is
 * roughly one turn: a call issued a second later is plainly a response,
 * and a call issued half an hour later is the session doing something else
 * entirely. Set too wide, unrelated later work gets read as compliance;
 * set too narrow, a session that paused to think reads as having abandoned
 * the task. Exported so a caller can tune it, and so its effect is
 * testable by passing a number rather than by waiting.
 */
export const RESPONSE_WINDOW_MS = 3 * 60 * 1000;

/** One call the session made after a firing. */
export interface FollowUpCall {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly tool: string;
  /** The command text, when the call carried one. */
  readonly command?: string;
}

/** A firing, and what the session did after it. */
export interface FiringEvidence {
  readonly entryId: string;
  /** When it fired, epoch milliseconds. */
  readonly at: number;
  /** What it did: `silent`, `nudged`, `blocked` or `overridden`. */
  readonly outcome: string;
  /** The tool the session was calling when it fired. */
  readonly tool?: string;
  /** The command it was calling with, as stored — possibly truncated. */
  readonly command?: string;
  /**
   * The calls this session made after the firing, in any order.
   *
   * Not required to be pre-filtered by time or by session: the derivation
   * applies the window itself, so a caller that hands over a session's
   * whole tail gets the same answer as one that trimmed it. A filter
   * applied by the caller is a rule living in two places.
   */
  readonly followUps: readonly FollowUpCall[];
}

/** How much the behavioural record actually establishes. */
export type DerivedConfidence = "none" | "low" | "high";

/** What the record says about one firing. */
export interface DerivedInterventionScore {
  /**
   * The score on the owner's 1–5 scale, or null when the record does not
   * support one. Null is an unrated firing, never a neutral 3 — a 3 is a
   * judgement ("it helped, but I could have figured it out myself") and
   * writing one for absent evidence would put an opinion nobody holds into
   * the aggregate.
   */
  readonly score: number | null;
  readonly confidence: DerivedConfidence;
  /** Whether a materially identical call followed inside the window. */
  readonly repeated: boolean;
  /** Whether the session did anything at all inside the window. */
  readonly proceeded: boolean;
  /** Plain-language account of what moved the score. */
  readonly reasons: readonly string[];
}

/**
 * Normalises a command for comparison.
 *
 * Whitespace-collapsed and lowercased, because the question is whether the
 * session **re-ran the same thing**, and a retry that differs only by an
 * extra space or a capital is the same thing by any reading that matters
 * here. Deliberately nothing cleverer: no flag reordering, no argument
 * parsing, no shell-aware tokenising. Each of those would make the
 * comparison right more often and wrong less predictably, and a matcher
 * whose false positives are hard to characterise is one nobody can
 * calibrate against — which is the failure this whole module exists to
 * replace.
 */
export function normaliseCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Whether a follow-up call is materially the same call as the one that
 * fired.
 *
 * Both the tool and the command must match. The tool alone is far too
 * coarse — nearly every call in a session is `Bash` — and the command
 * alone would treat an identical string issued through a different tool as
 * a repeat, which is a different act.
 *
 * **A firing with no command never matches.** A stored command is
 * truncated at a fixed length (`./capture.ts`), so two long commands that
 * differ only past the cut compare equal; that is an accepted imprecision
 * on a *present* command. An absent one is not imprecise, it is unknown,
 * and treating unknown as a match would score every command-less firing as
 * routed around.
 */
export function isSameCall(firing: FiringEvidence, call: FollowUpCall): boolean {
  if (firing.tool === undefined || firing.command === undefined) return false;
  if (call.command === undefined) return false;
  if (firing.tool !== call.tool) return false;
  return normaliseCommand(firing.command) === normaliseCommand(call.command);
}

/**
 * Whether an outcome means the session was actually refused.
 *
 * `overridden` counts as refused-and-routed-around on its own, and is
 * handled separately by `deriveInterventionScore` — it is the one outcome
 * where the session's own recorded reason says it went ahead anyway, which
 * is stronger evidence than any inference from a repeated command.
 */
function wasBlocked(outcome: string): boolean {
  return outcome === "blocked";
}

/**
 * Derives what one firing was worth from what followed it.
 *
 * The reasoning, stated as the rules it applies in order:
 *
 *   - **Overridden.** The session was blocked, wrote a reason, and went
 *     ahead. That is the scale's 1 almost verbatim — a block it had to
 *     route around — and it needs no inference, because the override is
 *     itself a record of the session disagreeing.
 *   - **Blocked, then the same call again inside the window.** The refusal
 *     did not change what the session did; it only delayed it. A 2 rather
 *     than a 1: the guard cost time without changing the outcome, but
 *     nothing here establishes it was *harmful*, and reserving the removal
 *     signal for the case where a session said so keeps the strongest
 *     thing this table can say attributable to somebody.
 *   - **Blocked, then something else.** The session changed course, which
 *     is a guard doing its job. A 4 — the top of what a derivation may
 *     award, and the honest reading of "saved me some time, but I wasn't
 *     about to do anything dangerous anyway", since whether it was about
 *     to is exactly what cannot be seen.
 *   - **Blocked, then nothing.** No evidence either way. The session may
 *     have accepted the refusal and stopped, or died. Null.
 *   - **Nudged or silent.** An advisory that did not refuse anything: the
 *     session was free to proceed and proceeding tells us nothing, so a
 *     repeat is not evidence of routing around. Only the deliberate act of
 *     overriding carries information here, and a nudge cannot be
 *     overridden. Null.
 *
 * A nudge scoring null is not a gap to be closed later by cleverness. A
 * nudge's value is whether its advice was *right*, and the session's
 * behaviour after one is the same whether it was right or wrong — so this
 * is precisely the case that has to be asked about rather than inferred,
 * and `./survey.ts` is what asks. The derivation covering only blocks is
 * the reason both routes exist.
 */
export function deriveInterventionScore(
  evidence: FiringEvidence,
  windowMs: number = RESPONSE_WINDOW_MS,
): DerivedInterventionScore {
  const inWindow = evidence.followUps.filter(
    (call) => call.at > evidence.at && call.at - evidence.at <= windowMs,
  );
  const proceeded = inWindow.length > 0;
  const repeated = inWindow.some((call) => isSameCall(evidence, call));

  if (evidence.outcome === "overridden") {
    return {
      score: MIN_INTERVENTION_SCORE,
      confidence: "high",
      repeated,
      proceeded,
      reasons: ["the session overrode the block and proceeded, recording a reason"],
    };
  }

  if (!wasBlocked(evidence.outcome)) {
    return {
      score: null,
      confidence: "none",
      repeated,
      proceeded,
      reasons: [
        "advisory only — what the session did next says nothing about whether it was right",
      ],
    };
  }

  if (repeated) {
    return {
      score: 2,
      confidence: "high",
      repeated,
      proceeded,
      reasons: ["blocked, then the session made a materially identical call inside the window"],
    };
  }

  if (!proceeded) {
    return {
      score: null,
      confidence: "none",
      repeated,
      proceeded,
      reasons: ["blocked, and the session made no further call inside the window"],
    };
  }

  return {
    score: MAX_DERIVED_SCORE,
    confidence: "low",
    repeated,
    proceeded,
    reasons: ["blocked, and the session did something different afterwards"],
  };
}

/**
 * Whether a derived score is one this module is permitted to have
 * produced.
 *
 * A guard against the derivation being widened later without the cap in
 * the header being revisited: every score written by the derived path goes
 * through here, so a change that started awarding 5s fails at the seam
 * rather than quietly filling the table with counterfactual claims. Null
 * is permitted — it is how "no evidence" is expressed.
 */
export function isDerivableScore(score: number | null): boolean {
  if (score === null) return true;
  if (!isValidInterventionScore(score)) return false;
  return score <= MAX_DERIVED_SCORE && score <= MAX_INTERVENTION_SCORE;
}
