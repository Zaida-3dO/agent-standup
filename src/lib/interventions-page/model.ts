// The interventions section of `/settings` — MILESTONES.md #128, derived
// entirely from the `GET /interventions/settings` answer.
//
// Pure functions over plain data, for the reason `src/lib/settings-page/`
// is: this repo's harness runs `environment: "node"` with no DOM, so the
// structure the page decides — which entries are grouped where, what each
// control offers, what each row says about itself — is only directly
// testable as values. The component under
// `src/components/interventions/` is the thin presentational layer over
// this, and nothing here imports the service layer or a database client.
//
// ── The one rule this module must not get wrong ────────────────────────
//
// "Inherit" is not a level. `src/lib/interventions/settings.ts`'s rule 1
// says an entry that has never been overridden tracks the product, so the
// control has to offer a choice that *removes* the stored row rather than
// one that writes the current default into it. The two look identical on
// screen and diverge permanently the moment a release retunes a default.
//
// So `choiceFor` reports `"inherit"` from the row's `levelSource` rather
// than by comparing its level against the default — a comparison that is
// right by coincidence for an entry sitting at the shipped value, and wrong
// for every entry an operator deliberately pinned to the value it already
// had.
import {
  levelsFor,
  writeForChoice,
  type InterventionSettingRow,
  type LevelChoice,
} from "@/lib/interventions/configurable";
import type { InterventionLevel, InterventionPhase } from "@/lib/interventions/types";

/** The answer `GET /api/interventions/settings` returns. */
export interface InterventionSettingsResponse {
  readonly interventions: readonly InterventionSettingRow[];
}

/**
 * How a level is worded for somebody who has to choose one.
 *
 * The enum's own spellings are accurate and unreadable — `nothing` reads as
 * a missing value and `block-overridable` reads as jargon — so each carries
 * a label and a one-line consequence. The consequence is the part that
 * matters: an operator is choosing what happens to an agent mid-call, and
 * "Blocks, with an override" says that where "block-overridable" does not.
 *
 * Keyed by the level so the mapping is exhaustive by construction, and a
 * level added to the ladder fails to compile here rather than rendering as
 * a blank option.
 */
export interface LevelOption {
  readonly value: LevelChoice;
  readonly label: string;
  readonly consequence: string;
}

const LEVEL_COPY: Readonly<Record<InterventionLevel, { label: string; consequence: string }>> = {
  nothing: {
    label: "Off",
    consequence: "Detected and recorded, and says nothing.",
  },
  nudge: {
    label: "Nudge",
    consequence: "Mentions it and lets the call through.",
  },
  "block-overridable": {
    label: "Block",
    consequence: "Refuses the call. An override can still pass it.",
  },
  "hard-block": {
    label: "Hard block",
    consequence: "Refuses the call outright.",
  },
};

/**
 * The word for "whatever this build ships", with the value named.
 *
 * The value is named because an option reading only "Inherit" makes an
 * operator open a second surface to find out what they would be inheriting
 * — and the whole reason this option exists is that choosing it is the
 * *safe* default, which it does not look like while its consequence is
 * hidden.
 */
export function inheritOption(defaultLevel: InterventionLevel): LevelOption {
  return {
    value: "inherit",
    label: `Use the default (${LEVEL_COPY[defaultLevel].label.toLowerCase()})`,
    consequence: "Tracks this build. A later release that retunes this entry changes it here too.",
  };
}

/**
 * Every choice this entry's control offers, inherit first.
 *
 * Inherit leads because it is the state an entry should return to when
 * somebody is unsure, and because putting it last — after the levels —
 * reads as the most extreme option on a ladder it is not on at all.
 *
 * The levels come from `levelsFor`, so a `post` entry is never offered a
 * blocking one. That is the fourth statement of the registry's invariant and
 * the only one that prevents the mistake rather than correcting it: the
 * clamp behind it would accept `hard-block` on a `post` entry, report
 * success, and run it as a nudge for ever.
 */
export function optionsFor(
  phase: InterventionPhase,
  defaultLevel: InterventionLevel,
): readonly LevelOption[] {
  return [
    inheritOption(defaultLevel),
    ...levelsFor(phase).map((level) => ({
      value: level,
      label: LEVEL_COPY[level].label,
      consequence: LEVEL_COPY[level].consequence,
    })),
  ];
}

/**
 * Which option is selected for a row.
 *
 * Read from `levelSource`, never by comparing `level` to `defaultLevel`. An
 * operator who deliberately pinned an entry to the level it already shipped
 * has a stored row and has made a decision that must survive the default
 * moving; a comparison would show that row as "inherit" and the next reset
 * would look like a no-op while actually discarding it.
 */
export function choiceFor(row: InterventionSettingRow): LevelChoice {
  return row.levelSource === "override" ? row.level : "inherit";
}

/**
 * Whether this entry is doing anything at all right now.
 *
 * Two different ways an entry can be silent, deliberately reported as one
 * flag: a stored `enabled: false` switches it off, and a level of `nothing`
 * leaves it recording without speaking. A reader scanning the list wants to
 * know which entries will never say anything to them, and the distinction
 * between the two silences is carried by `silenceReason` for the row that
 * needs to explain itself.
 */
export function isSilent(row: InterventionSettingRow): boolean {
  return !row.enabled || row.level === "nothing";
}

/**
 * Why an entry is silent, worded for the person looking at it — or `null`
 * when it is not silent.
 *
 * The three cases are genuinely different and an operator acts on each
 * differently, which is why this is not one sentence with a value
 * substituted in. An entry that *ships* off is an invitation; one somebody
 * turned off is a decision; one switched off entirely is not on the ladder
 * at all.
 */
export function silenceReason(row: InterventionSettingRow): string | null {
  if (!row.enabled) return "Switched off here. It is not evaluated at all.";
  if (row.level !== "nothing") return null;
  if (row.levelSource === "override") return "Turned off here. It is evaluated and says nothing.";
  return "Off by default. It is evaluated and says nothing until you turn it up.";
}

/** One entry, fully derived: what to draw, what it says, and what a change would write. */
export interface InterventionField {
  readonly id: string;
  readonly summary: string;
  readonly phase: InterventionPhase;
  readonly audience: InterventionSettingRow["audience"];
  readonly level: InterventionLevel;
  readonly defaultLevel: InterventionLevel;
  readonly choice: LevelChoice;
  readonly options: readonly LevelOption[];
  /** `true` when a stored row holds this entry's level — the reset is live. */
  readonly overridden: boolean;
  readonly silent: boolean;
  readonly silenceReason: string | null;
  /**
   * Why this entry cannot be set to a blocking level, or `null` when it can.
   *
   * Carried as prose rather than left implicit in a shorter menu, because a
   * `post` entry's control is missing two options an operator can see on the
   * entry above it, and an unexplained absence reads as a bug.
   */
  readonly blockingUnavailable: string | null;
}

export function fieldFor(row: InterventionSettingRow): InterventionField {
  return {
    id: row.id,
    summary: row.summary,
    phase: row.phase,
    audience: row.audience,
    level: row.level,
    defaultLevel: row.defaultLevel,
    choice: choiceFor(row),
    options: optionsFor(row.phase, row.defaultLevel),
    overridden: row.levelSource === "override",
    silent: isSilent(row),
    silenceReason: silenceReason(row),
    blockingUnavailable:
      row.phase === "post"
        ? "Runs after the call has happened, so it can inform but never refuse."
        : null,
  };
}

/**
 * The whole section, in the order the registry evaluates them.
 *
 * Deliberately **not** sorted, grouped or filtered. The server returns the
 * registry's own order, and two renders of one configuration being
 * byte-identical is what makes a screenshot or a diff of this page mean
 * something — `renderInterventionSettings` gives the same reasoning for the
 * ordering it produces.
 */
export interface InterventionsModel {
  readonly fields: readonly InterventionField[];
  /** How many entries carry a stored level, for the section's summary line. */
  readonly overriddenCount: number;
}

export function interventionsModel(response: InterventionSettingsResponse): InterventionsModel {
  const fields = response.interventions.map(fieldFor);
  return {
    fields,
    overriddenCount: fields.filter((field) => field.overridden).length,
  };
}

export { writeForChoice };
