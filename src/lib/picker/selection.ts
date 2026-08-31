// The model picker's vocabulary and its override rule — MILESTONES.md #70.
//
// ── What the row asks for, and the verb that matters ───────────────────
//
// "Store recommendations, **discourage** overrides at spawn, record when
// you override anyway." Discourage, not prevent — and the recorded override
// is the valuable half, not the friction.
//
// The reasoning is the same one this codebase reaches elsewhere: an agent
// asked to justify itself will always produce a justification, so a hard
// block buys nothing except a longer path to the same action. What it costs
// is the data. A blocked override is an event that never happened and
// cannot be learned from; a recorded one is a row saying *this dispatch
// disagreed with the recommendation, here is why*, and whether overridden
// runs go better or worse is the picker's own report card (SCHEMA.md
// §1084). So `override` is always permitted, always cheap to perform, and
// never silent.
//
// ── Ships switched off ─────────────────────────────────────────────────
//
// `model_picker.enabled` defaults to false and nothing here changes that.
// With the picker off there is no recommendation to resolve against, so a
// dispatch proceeds untouched: nothing stored, nothing discouraged, and
// `selection_reason` left null. The mechanism is bounded code; the
// judgement is data, and the data accrues whether or not this is switched
// on.
//
// ── This module holds no database client ───────────────────────────────
//
// Everything here is arithmetic over values handed in, so every threshold
// is assertable against a literal rather than a fixture — the posture
// `@/lib/scoring/run-scores.ts` and `@/lib/interventions/scoring.ts` both
// take.

/**
 * Why a model was used — the `SelectionReason` enum of SCHEMA.md §1084,
 * mirrored here so the front end and the picker share one vocabulary
 * without importing a database type.
 *
 * `override` is the valuable one: an agent rejecting the soft-deny.
 */
export type SelectionReason = "recommended" | "exploration" | "override" | "pinned";

export const SELECTION_REASONS = [
  "recommended",
  "exploration",
  "override",
  "pinned",
] as const satisfies readonly SelectionReason[];

export function isSelectionReason(value: unknown): value is SelectionReason {
  return typeof value === "string" && (SELECTION_REASONS as readonly string[]).includes(value);
}

/**
 * A recommendation the picker made, as stored on the run.
 *
 * `strength` is the confidence at dispatch time, 0-1. It is what licenses
 * an exploration in the first place (SCHEMA.md §1085) and what #69 flags a
 * card on, so it is carried rather than derived twice.
 */
export interface Recommendation {
  readonly model: string;
  readonly effort: string;
  /** Confidence, 0-1. */
  readonly strength: number;
  /** Plain-language account of why this tier, shown when discouraging an override. */
  readonly rationale: string;
}

/** Whether a value is a usable confidence. */
export function isValidStrength(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * What a dispatch actually chose, and why — the row written to
 * `Run.selectionReason` / `Run.recommendationStrength`.
 *
 * `reason` is null when no dispatch decision stands behind the run. That is
 * the truthful value for a run cut from telemetry, and the excludable one:
 * SCHEMA.md §1084 is explicit that defaulting it to `recommended` would put
 * runs nobody recommended anything about into the comparison group
 * recommendations are graded against, and poison it.
 */
export interface Selection {
  readonly model: string;
  readonly effort: string;
  readonly reason: SelectionReason | null;
  readonly recommendationStrength: number | null;
  /** Why the dispatcher overrode, when it did. Null otherwise. */
  readonly overrideReason: string | null;
}

/**
 * Resolves what a dispatch chose against what was recommended.
 *
 * The rules, in order:
 *
 *   - **No recommendation** (picker off, or nothing to recommend) → the
 *     chosen tier stands with `reason: null` and no strength. Not
 *     `override`: there was nothing to override.
 *   - **Pinned** → `pinned`, whatever was recommended. A pin is a standing
 *     instruction, not a per-dispatch disagreement, and counting it as an
 *     override would fill the override data with decisions nobody made at
 *     dispatch time.
 *   - **Chose what was recommended** → `recommended`.
 *   - **Chose otherwise** → `override`, carrying the reason given.
 *
 * The recommendation's strength is stored **whatever was chosen**,
 * including on an override. That is what makes overrides gradeable: a
 * dispatch that overrode a 0.9-confidence recommendation and went badly
 * says something quite different from one that overrode a 0.3.
 */
export function resolveSelection(args: {
  readonly chosenModel: string;
  readonly chosenEffort: string;
  readonly recommendation: Recommendation | null;
  readonly pinned?: boolean;
  readonly overrideReason?: string | null;
  readonly exploration?: boolean;
}): Selection {
  const { chosenModel, chosenEffort, recommendation } = args;

  if (recommendation === null) {
    return {
      model: chosenModel,
      effort: chosenEffort,
      reason: null,
      recommendationStrength: null,
      overrideReason: null,
    };
  }

  const strength = isValidStrength(recommendation.strength) ? recommendation.strength : null;

  if (args.pinned === true) {
    return {
      model: chosenModel,
      effort: chosenEffort,
      reason: "pinned",
      recommendationStrength: strength,
      overrideReason: null,
    };
  }

  const matches = chosenModel === recommendation.model && chosenEffort === recommendation.effort;

  if (matches) {
    // An exploration is the picker deliberately taking a cheaper tier, so
    // the "recommendation" it matches IS the experiment — recorded as such
    // rather than as an ordinary recommendation, because #69 flags on it
    // and the picker must exclude it from its own report card.
    return {
      model: chosenModel,
      effort: chosenEffort,
      reason: args.exploration === true ? "exploration" : "recommended",
      recommendationStrength: strength,
      overrideReason: null,
    };
  }

  return {
    model: chosenModel,
    effort: chosenEffort,
    reason: "override",
    recommendationStrength: strength,
    // Normalised to null rather than kept as an empty string: "" and absent
    // both mean nobody said why, and storing two spellings of that would
    // make every reader check for both.
    overrideReason: normaliseOverrideReason(args.overrideReason),
  };
}

function normaliseOverrideReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * What to say to a dispatcher choosing against the recommendation.
 *
 * **Discouragement, not refusal.** The text names what was recommended and
 * why, and asks for a reason — then the dispatch proceeds regardless. It
 * returns null when there is nothing to discourage, so a caller cannot
 * accidentally show a warning on an ordinary dispatch.
 *
 * Nothing here refuses, and nothing here should grow a refusal: the row
 * says discourage, and the module header says why a block would cost data
 * without buying compliance.
 */
export function overrideDiscouragement(
  recommendation: Recommendation | null,
  chosenModel: string,
  chosenEffort: string,
): string | null {
  if (recommendation === null) return null;
  if (chosenModel === recommendation.model && chosenEffort === recommendation.effort) return null;

  const confidence = isValidStrength(recommendation.strength)
    ? ` (confidence ${recommendation.strength.toFixed(2)})`
    : "";
  return (
    `The picker recommends ${recommendation.model} at ${recommendation.effort} effort${confidence}: ` +
    `${recommendation.rationale} You are choosing ${chosenModel} at ${chosenEffort}. ` +
    `That is allowed — please record why, so the picker can learn whether the override was right.`
  );
}

/**
 * Whether an override is missing its reason.
 *
 * Reported so a surface can **ask again**, not so a caller can refuse. An
 * override with no reason is still recorded — a row saying "somebody
 * disagreed and did not say why" is weaker data than one with a reason and
 * far stronger than no row at all.
 */
export function overrideLacksReason(selection: Selection): boolean {
  return selection.reason === "override" && selection.overrideReason === null;
}
