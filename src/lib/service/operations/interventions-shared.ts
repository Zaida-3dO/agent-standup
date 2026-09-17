// Shared shapes for the intervention-configuration operations — MILESTONES.md
// #128, `docs/plans/INTERVENTIONS.md` ("Defaults, overrides, and retiring an
// entry").
//
// One module rather than repeating this in list/set/clear, for the reason
// `./settings-shared.ts` gives for the same split: the rendered shape and
// the row-writing SQL are the contract, and they must not drift between the
// three operations that use them.
//
// ── Why these are their own operations at all ──────────────────────────
//
// `put_setting` and `delete_setting` look like they should serve. They
// cannot, and the reason is a deliberate design decision rather than an
// oversight: both call `requireSettingKey`, which refuses anything outside
// the closed compile-time `SETTINGS_REGISTRY`, and
// `src/lib/interventions/settings.ts` argues at length why the catalogue's
// keys are **not** in that registry — the catalogue grows and sheds entries,
// while a `SettingKey` that is deleted takes with it the type every stored
// row validates against.
//
// Widening `requireSettingKey` to admit the namespace would have bought the
// write path at the cost of the check that makes it safe: `put_setting`
// validates against the key's *declared* schema, and there is no declared
// schema for `interventions.<anything>.level`. Every one of these keys would
// have become writable with no validation and no catalogue check, so a typo
// in an id would store a row that resolves to nothing for ever. These
// operations instead validate against the catalogue itself — the id must
// name an entry this build ships — and against the same Zod schemas
// `resolveInterventionSettings` reads rows back through.

import { InvalidInputError, NotFoundError } from "../errors";
import type { TransactionHandle } from "../context";
import { BUILTIN_INTERVENTIONS } from "@/lib/interventions/builtins";
import {
  INTERVENTION_SETTING_PREFIX,
  interventionSettingKey,
  readInterventionSettingRows,
  renderInterventionSettings,
  resolveInterventionSettings,
  type InterventionOverrideField,
} from "@/lib/interventions/settings";
import {
  levelsFor,
  rejectionForLevel,
  type InterventionSettingRow,
} from "@/lib/interventions/configurable";
import type { Intervention, InterventionLevel } from "@/lib/interventions/types";

/**
 * The catalogue these operations configure.
 *
 * A module constant rather than a parameter, because "which entries exist"
 * is a property of the build and not of the call — the same reason
 * `produceServiceFindings` reads `BUILTIN_INTERVENTIONS` directly. Exported
 * so a test can assert against the same list the operations serve rather
 * than a copy of it.
 */
export const CONFIGURABLE_INTERVENTIONS: readonly Intervention[] = BUILTIN_INTERVENTIONS;

/** The entry with this id, or a `not_found` naming what was asked for. */
export function requireEntry(id: string): Intervention {
  const entry = CONFIGURABLE_INTERVENTIONS.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    // Deliberately **not** "unknown intervention" alone. A stored row for an
    // id this build does not carry is a supported state —
    // `ResolvedInterventionSettings.unknownIds` keeps it precisely so a
    // retired entry's configuration survives — so the refusal has to
    // distinguish "you cannot configure this" from "this has been thrown
    // away", which it does by naming the build as the thing that lacks it.
    throw new NotFoundError(`${id} is not an intervention this build ships.`, { fields: ["id"] });
  }
  return entry;
}

/**
 * Renders every catalogue entry with its resolved level, for a surface.
 *
 * Reads the stored rows once and resolves them through the **same**
 * `resolveInterventionSettings` the hook path uses, rather than querying per
 * entry or re-implementing the merge. A second resolver would be a second
 * answer to "what is this entry's level", and the two would disagree exactly
 * when a row failed validation — the case where being right matters most.
 */
export async function renderInterventionRows(
  db: TransactionHandle,
): Promise<readonly InterventionSettingRow[]> {
  const stored = await readInterventionSettingRows(db);
  const { overrides } = resolveInterventionSettings({
    stored,
    entries: CONFIGURABLE_INTERVENTIONS,
  });
  const rendered = renderInterventionSettings({
    entries: CONFIGURABLE_INTERVENTIONS,
    overrides,
  });

  // Indexed by entry id, then by field, so each entry reads its two fields
  // in one pass. A nested map rather than one keyed on a composed string: an
  // intervention id is not guaranteed to be free of any given character —
  // the same reason `parseInterventionSettingKey` parses from the right
  // rather than splitting on every dot — so composing a key would be a
  // second place an unusual id could collide with another.
  const byEntry = new Map<string, Map<string, (typeof rendered)[number]>>();
  for (const row of rendered) {
    const fields = byEntry.get(row.id) ?? new Map<string, (typeof rendered)[number]>();
    fields.set(row.field, row);
    byEntry.set(row.id, fields);
  }
  const at = (id: string, field: InterventionOverrideField) => byEntry.get(id)?.get(field);

  return CONFIGURABLE_INTERVENTIONS.map((entry): InterventionSettingRow => {
    const level = at(entry.id, "level");
    const enabled = at(entry.id, "enabled");
    return {
      id: entry.id,
      summary: entry.summary,
      phase: entry.phase,
      audience: entry.audience,
      source: entry.source,
      // Falls back to the entry's own default rather than throwing if the
      // rendering is somehow missing a field: a settings page that cannot
      // draw one row is worse than one drawing it at the value the registry
      // would actually use, which is what the default is.
      level: (level?.effectiveValue as InterventionLevel | undefined) ?? entry.defaultLevel,
      defaultLevel: entry.defaultLevel,
      levelSource: level?.source ?? "default",
      availableLevels: levelsFor(entry.phase),
      levelKey: interventionSettingKey(entry.id, "level"),
      enabled: (enabled?.effectiveValue as boolean | undefined) ?? true,
      enabledSource: enabled?.source ?? "default",
    };
  });
}

/**
 * Refuses a level this entry's phase cannot take.
 *
 * **The service refuses what the UI declines to offer**, rather than leaning
 * on `resolveLevel`'s clamp. The clamp is the right behaviour for a value
 * already stored — it keeps a bad row from constructing an impossible state
 * — but it is the wrong behaviour for a write being made now: it would
 * accept the call, report success, and run the entry at a level the caller
 * did not choose. A refusal at the write is the only point where the caller
 * is still there to be told.
 */
export function assertLevelAllowed(entry: Intervention, level: InterventionLevel): void {
  const rejection = rejectionForLevel(entry.phase, level);
  if (rejection !== null) throw new InvalidInputError(rejection, { fields: ["level"] });
}

export { INTERVENTION_SETTING_PREFIX, interventionSettingKey };
