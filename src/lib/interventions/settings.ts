// Per-entry configuration for interventions — MILESTONES.md #128,
// `docs/plans/INTERVENTIONS.md` ("Defaults, overrides, and retiring an
// entry").
//
// `./registry.ts` already applies an `InterventionOverride` to an entry.
// What it has never had is anywhere for one to come *from*: the override
// plumbing was built and tested end to end against overrides constructed in
// a test body, so an installation could not switch an entry off or re-level
// it. This module is that missing half — it turns stored settings rows into
// the `overrides` map `evaluate` already accepts.
//
// ── Why these keys are not in `SETTINGS_REGISTRY` ──────────────────────
//
// The settings registry is a **closed, compile-time** record: `SettingKey`
// is `keyof typeof SETTINGS_REGISTRY`, every key is declared as a literal,
// and `SettingsValues` types each one individually. That shape is right for
// what it holds — a fixed set of knobs a build knows about — and it is what
// gives `snapshot.values["items.max_depth"]` a `number` rather than an
// `unknown`.
//
// The catalogue is the opposite kind of set. It is explicitly a growing
// list that new findings are appended to, each entry has six overridable
// fields, and an entry can be retired. Declaring the cross product as
// literals would mean six hand-written entries per catalogue entry, all
// but identical, and — the part that actually decides it — **a retired
// entry's keys could never be removed**, because deleting a `SettingKey`
// deletes the type that every stored row for it validates against. The
// registry has one answer for a row whose key it does not declare
// (`unrecognised`, inert, never deleted), and applying that to a catalogue
// that is *designed* to shed entries would accumulate permanent debris.
//
// So the keys are resolved dynamically, from one namespace, and the
// namespace itself is what the settings registry would have to declare if
// these were ever surfaced through it. Nothing here bypasses validation:
// every field is parsed by the same Zod schemas the types are built from,
// and a row that fails is dropped with a reason rather than applied.
//
// ── The two rules this module exists to get right ─────────────────────
//
// Both are stated in `INTERVENTIONS.md` and both are easy to implement
// backwards:
//
//   1. **An entry that has never been overridden tracks the product.** An
//      absent field is *absent*, never materialised into the current
//      default. If a later release retunes a level or a message, an
//      installation that never expressed an opinion picks it up on update
//      with nothing to migrate. The moment this module wrote a resolved
//      default into a row, that would stop being true silently — the row
//      would look identical to a deliberate choice.
//   2. **An override is a decision and it sticks.** A field that *is*
//      stored is applied even when the shipped default has moved on. The
//      cost is that an installation keeps its own answer when the product's
//      improves, which is the correct trade: the alternative is a product
//      update reversing a deliberate choice.
//
// Together those make **retiring an entry a release rather than a
// migration**: drop it from the catalogue and every installation that never
// had an opinion stops seeing it, while the few that deliberately
// configured it keep their rows until they say otherwise. `unknownIds`
// below is what makes the second half true — a stored row for an entry
// absent from this build's catalogue is kept and reported, not deleted,
// because deleting it would destroy the one record that the installation
// ever chose.

import { z } from "zod";
import {
  INTERVENTION_LEVELS,
  INTERVENTION_TIMINGS,
  type Intervention,
  type InterventionOverride,
} from "./types";

/**
 * The namespace every intervention settings key sits under.
 *
 * One prefix rather than one per entry, so that "show me how interventions
 * are configured here" is a prefix scan rather than a join against the
 * catalogue — which matters most for exactly the rows the catalogue can no
 * longer explain, the ones belonging to a retired entry.
 */
export const INTERVENTION_SETTING_PREFIX = "interventions";

/**
 * The fields of an entry an installation may override.
 *
 * Closed, and deliberately not "every field on `Intervention`". `phase` is
 * absent because a `post` entry configured to `pre` would be claiming to
 * run before a call that has already happened — the registry would clamp
 * it, so the setting would be one that silently does nothing. `summary` and
 * `id` are absent because they identify the entry rather than configure it.
 */
export const INTERVENTION_OVERRIDE_FIELDS = [
  "enabled",
  "level",
  "timing",
  "message_plain",
  "message_prominent",
] as const;

export type InterventionOverrideField = (typeof INTERVENTION_OVERRIDE_FIELDS)[number];

/**
 * The schema each overridable field validates against.
 *
 * Built from the same `as const` tuples the types are, rather than from a
 * parallel list of strings. A level added to `INTERVENTION_LEVELS` is
 * accepted here the moment it exists, and — the direction that actually
 * bites — a level *removed* from it starts being rejected here rather than
 * being applied as a value no code branches on any more.
 */
const FIELD_SCHEMAS = {
  enabled: z.boolean(),
  level: z.enum(INTERVENTION_LEVELS),
  timing: z.enum(INTERVENTION_TIMINGS),
  message_plain: z.string().trim().min(1),
  message_prominent: z.string().trim().min(1),
} as const satisfies Record<InterventionOverrideField, z.ZodTypeAny>;

/**
 * Builds the settings key for one entry's one field.
 *
 * The single place the key format is written. A caller that assembled the
 * string itself would be a second spelling of the same thing, and the two
 * would drift in the direction nobody notices — a write landing on a key no
 * read ever looks at.
 */
export function interventionSettingKey(id: string, field: InterventionOverrideField): string {
  return `${INTERVENTION_SETTING_PREFIX}.${id}.${field}`;
}

/** A key parsed back into the entry and field it configures. */
export interface ParsedInterventionKey {
  readonly id: string;
  readonly field: InterventionOverrideField;
}

/**
 * Reads a stored key back, or `null` if it is not one of ours.
 *
 * Parsed from the right rather than by splitting on every dot, because an
 * intervention id is not guaranteed to be dot-free and a left-to-right
 * split would silently truncate one that was not. The field is the last
 * segment, the prefix is the first, and everything between them is the id.
 */
export function parseInterventionSettingKey(key: string): ParsedInterventionKey | null {
  const separator = key.indexOf(".");
  if (separator <= 0) return null;
  if (key.slice(0, separator) !== INTERVENTION_SETTING_PREFIX) return null;

  const remainder = key.slice(separator + 1);
  const lastDot = remainder.lastIndexOf(".");
  if (lastDot <= 0) return null;

  const id = remainder.slice(0, lastDot);
  const field = remainder.slice(lastDot + 1);
  if (id.trim() === "") return null;
  if (!(INTERVENTION_OVERRIDE_FIELDS as readonly string[]).includes(field)) return null;

  return { id, field: field as InterventionOverrideField };
}

/** One stored configuration row, as this module needs to see it. */
export interface StoredInterventionSetting {
  readonly key: string;
  readonly value: unknown;
}

/** A stored row that did not survive its field's schema. */
export interface RejectedInterventionSetting {
  readonly key: string;
  readonly storedValue: unknown;
  readonly reason: string;
}

export interface ResolvedInterventionSettings {
  /** Per-id overrides, in the shape `evaluate` already accepts. */
  readonly overrides: Readonly<Record<string, InterventionOverride>>;
  /**
   * Rows that failed validation. The default was used for that field.
   *
   * Reported rather than thrown for the reason the settings resolver gives
   * for the same case: refusing to answer because one stored value went
   * stale turns a configuration nit into every tool call failing.
   */
  readonly rejected: readonly RejectedInterventionSetting[];
  /**
   * Ids with stored rows that this build's catalogue does not contain.
   *
   * **Kept, never deleted.** This is the retired-entry case, and the row is
   * the only surviving record that the installation ever made a decision
   * about that entry: an entry can also be absent because a build is older
   * than the row, or because a catalogue entry was renamed. Deleting on
   * absence would silently discard a deliberate choice in all three cases
   * to tidy up after one of them.
   */
  readonly unknownIds: readonly string[];
}

/**
 * Turns stored rows into the overrides map, dropping what does not validate.
 *
 * ── What "absent" means here, and why it is never filled in ────────────
 *
 * A field with no row is left off the returned object entirely. It is not
 * set to the entry's current default, and the distinction is the whole of
 * rule 1 above: `{level: "nudge"}` and `{}` produce identical behaviour
 * identical behaviour until a release retunes the default, and opposite
 * behaviour from that release onwards.
 * Writing the resolved default here would convert every installation into
 * one that had expressed an opinion about everything, permanently, on the
 * first read — and nothing downstream could tell that had happened.
 */
export function resolveInterventionSettings(options: {
  readonly stored: readonly StoredInterventionSetting[];
  readonly entries: readonly Intervention[];
}): ResolvedInterventionSettings {
  const { stored, entries } = options;
  const known = new Set(entries.map((entry) => entry.id));

  // A mutable mirror of `InterventionOverride`, assembled field by field
  // as the rows arrive and handed back under the readonly type. The public
  // shape stays readonly — callers must not edit a resolved override — and
  // this is the one place that builds one.
  interface MutableOverride {
    enabled?: boolean;
    level?: InterventionOverride["level"];
    timing?: InterventionOverride["timing"];
    messages?: { plain?: string; prominent?: string };
  }

  const overrides: Record<string, MutableOverride> = {};
  const rejected: RejectedInterventionSetting[] = [];
  const unknownIds = new Set<string>();

  for (const row of stored) {
    const parsed = parseInterventionSettingKey(row.key);
    // A row under a different namespace is not this module's business —
    // silently ignored rather than reported, because `stored` may
    // legitimately be handed every settings row there is.
    if (parsed === null) continue;

    const checked = FIELD_SCHEMAS[parsed.field].safeParse(row.value);
    if (!checked.success) {
      rejected.push({
        key: row.key,
        storedValue: row.value,
        reason: checked.error.issues.map((issue) => issue.message).join("; "),
      });
      continue;
    }

    // Recorded *after* validation, so a malformed row for an unknown id is
    // reported once as the malformed row it is, rather than twice.
    if (!known.has(parsed.id)) unknownIds.add(parsed.id);

    const target = (overrides[parsed.id] ??= {});
    switch (parsed.field) {
      case "enabled":
        target.enabled = checked.data as boolean;
        break;
      case "level":
        target.level = checked.data as InterventionOverride["level"];
        break;
      case "timing":
        target.timing = checked.data as InterventionOverride["timing"];
        break;
      case "message_plain":
        (target.messages ??= {}).plain = checked.data as string;
        break;
      case "message_prominent":
        (target.messages ??= {}).prominent = checked.data as string;
        break;
    }
  }

  return {
    overrides: overrides as Readonly<Record<string, InterventionOverride>>,
    rejected,
    unknownIds: [...unknownIds],
  };
}

/** One entry rendered with its defaults and whatever is overridden. */
export interface RenderedInterventionSetting {
  readonly id: string;
  readonly field: InterventionOverrideField;
  readonly key: string;
  /** What this build ships. */
  readonly defaultValue: unknown;
  /** What is stored, when anything is. */
  readonly overriddenValue?: unknown;
  /** Which of the two the entry actually runs at. */
  readonly effectiveValue: unknown;
  /**
   * `default` when nothing is stored — the state that tracks the product.
   *
   * The field a settings page needs in order to offer "reset to default"
   * honestly: a reset is a *deletion* of the row, not a write of the
   * current default, and a surface that could not tell the two apart would
   * offer a reset that silently pinned the value forever.
   */
  readonly source: "default" | "override";
}

/**
 * Renders every overridable field of every entry, for a settings surface.
 *
 * Ordered by the registry's own order and then by the field list, so two
 * renders of the same configuration are byte-identical — the property that
 * makes a diff of this output mean something.
 */
export function renderInterventionSettings(options: {
  readonly entries: readonly Intervention[];
  readonly overrides: Readonly<Record<string, InterventionOverride>>;
}): readonly RenderedInterventionSetting[] {
  const { entries, overrides } = options;
  const rendered: RenderedInterventionSetting[] = [];

  for (const entry of entries) {
    const override = overrides[entry.id];
    for (const field of INTERVENTION_OVERRIDE_FIELDS) {
      const defaultValue = defaultFor(entry, field);
      const overriddenValue = overriddenFor(override, field);
      rendered.push({
        id: entry.id,
        field,
        key: interventionSettingKey(entry.id, field),
        defaultValue,
        ...(overriddenValue === undefined ? {} : { overriddenValue }),
        effectiveValue: overriddenValue ?? defaultValue,
        source: overriddenValue === undefined ? "default" : "override",
      });
    }
  }

  return rendered;
}

/**
 * What an entry ships with for one field.
 *
 * `enabled` has no field on `Intervention` because an entry that ships
 * switched off would be one the catalogue lists and the registry never
 * runs. The default is therefore `true` for every built-in, and an
 * installation turns one off by storing `false` — which is the direction
 * that keeps "never overridden tracks the product" meaningful.
 */
function defaultFor(entry: Intervention, field: InterventionOverrideField): unknown {
  switch (field) {
    case "enabled":
      return true;
    case "level":
      return entry.defaultLevel;
    case "timing":
      return entry.defaultTiming;
    case "message_plain":
      return entry.messages.plain;
    case "message_prominent":
      return entry.messages.prominent;
  }
}

/** What is stored for one field, or `undefined` when nothing is. */
function overriddenFor(
  override: InterventionOverride | undefined,
  field: InterventionOverrideField,
): unknown {
  if (override === undefined) return undefined;
  switch (field) {
    case "enabled":
      return override.enabled;
    case "level":
      return override.level;
    case "timing":
      return override.timing;
    case "message_plain":
      return override.messages?.plain;
    case "message_prominent":
      return override.messages?.prominent;
  }
}
