// What an operator may actually *do* to a catalogue entry — the decision
// layer between `./settings.ts` (which turns stored rows into an overrides
// map) and every surface that offers someone a control.
//
// ── Why this is a module and not a component's local helper ─────────────
//
// `./settings.ts` closed one half of the override story: an installation's
// stored rows become the `overrides` map `evaluate` already accepts. The
// other half is that **nothing ever wrote those rows**, so an entry could
// be re-levelled only by reaching past the application into the table. A
// surface that offers the missing control has to answer two questions the
// settings module deliberately does not:
//
//   1. **Which levels may this entry take?** Not every level is legal for
//      every entry, and the constraint is a property of the entry's phase
//      rather than of the widget drawn for it.
//   2. **What does "back to the default" mean as an operation?** It is a
//      *deletion*, and getting that wrong is silent — see below.
//
// Both answers belong beside each other and away from React, because both
// are enforced in the service as well as offered in the UI. A constraint
// that lives only in a component is not a constraint: it is a suggestion
// that anyone calling the API directly is free to decline.
//
// ── A `post` entry can never block, and this is the third place ─────────
//
// `./registry.ts` states the invariant and enforces it three times over —
// `assertRegistryValid` throws on a registered entry whose default blocks,
// `resolveLevel` clamps a configured override, and `evaluate` clamps a
// predicate's returned verdict. Each catches a different way of getting it
// wrong, and the clamps are deliberately forgiving: configuration must not
// be able to construct a state the code says is impossible, so it is
// quietly corrected rather than thrown at.
//
// A settings surface needs the same rule stated a fourth way, in the one
// direction the clamps cannot help with: **do not offer it in the first
// place.** Relying on the clamp alone would let an operator select
// `hard-block` on a `post` entry, see it accepted, and reasonably believe
// they had configured a block — while the registry silently ran it as a
// nudge for ever. That is a worse outcome than a refusal, because it is
// indistinguishable from success. So `levelsFor` narrows the menu, and
// `rejectionForLevel` refuses the write, while the clamp still sits behind
// both as the last line.
//
// The levels are **not** re-listed here. They are filtered from
// `INTERVENTION_LEVELS` through `isBlockingLevel`, so a level added to the
// ladder appears in the right menus without this module being edited, and a
// level whose blocking-ness changes moves between them on its own. A
// hand-written parallel list is exactly how the two would drift.

import {
  INTERVENTION_LEVELS,
  isBlockingLevel,
  type Intervention,
  type InterventionLevel,
  type InterventionPhase,
} from "./types";

/**
 * The levels an entry of this phase may be configured to.
 *
 * Derived, never declared: `pre` takes the whole ladder, and `post` takes
 * the non-blocking part of it. Returned in the ladder's own order, weakest
 * first, so a menu built from it reads as an escalation rather than as an
 * arbitrary set.
 */
export function levelsFor(phase: InterventionPhase): readonly InterventionLevel[] {
  if (phase === "pre") return INTERVENTION_LEVELS;
  return INTERVENTION_LEVELS.filter((level) => !isBlockingLevel(level));
}

/**
 * Why a level cannot be set on an entry of this phase, or `null` if it can.
 *
 * A message rather than a boolean, and it names the phase and the level,
 * because this string is what a caller who went around the UI actually
 * reads. "Invalid level" would send someone to check their spelling of a
 * value that is spelled correctly and is simply not available here.
 */
export function rejectionForLevel(
  phase: InterventionPhase,
  level: InterventionLevel,
): string | null {
  if (phase !== "post" || !isBlockingLevel(level)) return null;
  return (
    `"${level}" is a blocking level and this is a ${phase} entry, which runs after the tool ` +
    `call has already happened and so cannot refuse it. Set it to a non-blocking level ` +
    `(${levelsFor(phase).join(", ")}) instead.`
  );
}

/**
 * What an operator is choosing between for one entry's level.
 *
 * `"inherit"` is a first-class member of this union rather than a `null`
 * level, and that is the whole point of the type. The two are not the same
 * choice: a stored `nudge` and an absent row behave identically while the
 * shipped default holds, and diverge the moment a release retunes it. So a
 * surface that represented "inherit" as "whatever the default resolves to"
 * would write that resolved default into a row and permanently pin it. See
 * `settings.ts`'s rule 1 — the row would then look identical to a
 * deliberate choice, and nothing downstream could tell.
 */
export type LevelChoice = InterventionLevel | "inherit";

/**
 * Which write a chosen level implies.
 *
 * The single place the "inherit is a deletion" mapping is made, so no
 * caller has to remember it. A surface that got this backwards would go on
 * working for as long as the shipped default never moved, which is the
 * failure mode that cannot be caught by testing the surface against itself.
 */
export type LevelWrite =
  { readonly action: "clear" } | { readonly action: "set"; readonly level: InterventionLevel };

export function writeForChoice(choice: LevelChoice): LevelWrite {
  if (choice === "inherit") return { action: "clear" };
  return { action: "set", level: choice };
}

/**
 * One catalogue entry as a settings surface needs it — MILESTONES.md #128.
 *
 * Carries the entry's identity and its *resolved* configuration, plus the
 * two things a control needs that neither `Intervention` nor
 * `RenderedInterventionSetting` carries on its own: which levels are
 * available, and whether the current one is inherited or chosen.
 *
 * **`levelSource` is not derivable from `level`.** An entry showing `nudge`
 * may be inheriting a shipped `nudge` or holding a stored one, and the two
 * are different states with different consequences on the next release.
 * This is the same distinction `RenderedInterventionSetting.source` draws
 * and for the same reason: a surface that could not tell them apart would
 * offer a reset that silently pinned the value.
 */
export interface InterventionSettingRow {
  readonly id: string;
  readonly summary: string;
  readonly phase: InterventionPhase;
  readonly audience: Intervention["audience"];
  readonly source: Intervention["source"];
  /** The level this entry actually runs at right now. */
  readonly level: InterventionLevel;
  /** What this build ships, shown beside the choice so "inherit" names a value. */
  readonly defaultLevel: InterventionLevel;
  /** `override` when a row is stored for the level, `default` when none is. */
  readonly levelSource: "default" | "override";
  /** The levels this entry's phase permits, weakest first. */
  readonly availableLevels: readonly InterventionLevel[];
  /** The settings key the level is stored under, for a caller that writes it. */
  readonly levelKey: string;
  /** `false` when a stored row switches this entry off entirely. */
  readonly enabled: boolean;
  /** `override` when a row is stored for `enabled`, `default` when none is. */
  readonly enabledSource: "default" | "override";
}
