// Shared shapes and helpers for the settings service operations
// (MILESTONES.md #78, SCHEMA.md §17, §19). One module rather than repeating
// this in each of get/patch/put/delete, because the rendered shape and the
// revision-bump SQL are exactly the contract §17.2/§17.3 describe and must
// not drift between the four operations that use them.
import { NotFoundError } from "../errors";
import { appendEvent } from "@/lib/events";
import type { TransactionHandle } from "../context";
import type { Caller } from "../context";
import {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  isSettingKey,
  validateSetting,
  type SettingKey,
} from "@/lib/settings";

/** One row of `settings`, as this module reads and writes it. */
export interface RawSettingRow {
  key: string;
  value: unknown;
}

/**
 * One declared setting, rendered for a caller — SCHEMA.md §19's
 * `GET /settings`: "every declared setting with its value, source (default
 * or override), schema, label, help, category and validation state."
 *
 * `source` distinguishes "at the default" from "someone set it", which is
 * the same distinction §17.2's table draws for the row itself — an override
 * that fails its schema is reported as `invalid-override` and served the
 * default value, mirroring `resolveSettings`'s own fallback (SCHEMA.md
 * §17.3) rather than inventing a second disagreement policy at the read
 * surface.
 */
export interface RenderedSetting {
  readonly key: SettingKey;
  readonly value: unknown;
  readonly source: "default" | "override" | "invalid-override";
  readonly label: string;
  readonly help: string;
  readonly category: string;
  readonly appliesWhen: string;
  readonly sensitive: boolean;
  readonly irreversible: boolean;
  /** Present only when source is "invalid-override" — what was stored and why it was refused. */
  readonly invalidOverride?: { storedValue: unknown; errors: readonly string[] };
}

/** Renders every declared key against the stored override rows. */
export function renderAllSettings(overrideRows: readonly RawSettingRow[]): RenderedSetting[] {
  const byKey = new Map(overrideRows.map((row) => [row.key, row.value]));
  return SETTING_KEYS.map((key) => renderOne(key, byKey.has(key) ? byKey.get(key) : undefined));
}

/**
 * A stored override for a key this build does not declare — SCHEMA.md §17.3:
 * "The row is **inert**… It is listed under 'Unrecognised' on `/settings`
 * with a remove action."
 *
 * Carried separately from `RenderedSetting` rather than folded into it,
 * because the two are genuinely different things: a rendered setting has a
 * label, help, category and schema, and an unrecognised row has none of
 * those by definition — the registry entry that would supply them is exactly
 * what is missing. Giving it placeholder ones would make an undeclared key
 * look declared.
 */
export interface UnrecognisedSetting {
  readonly key: string;
  readonly storedValue: unknown;
}

/**
 * The stored rows whose keys the registry does not declare.
 *
 * Mirrors `resolveSettings`'s own partition (SCHEMA.md §17.3) rather than
 * inventing a second one: a row is unrecognised when `isSettingKey` says so,
 * and that is the only test either place applies.
 */
export function renderUnrecognisedSettings(
  overrideRows: readonly RawSettingRow[],
): UnrecognisedSetting[] {
  return overrideRows
    .filter((row) => !isSettingKey(row.key))
    .map((row) => ({ key: row.key, storedValue: row.value }));
}

/** Renders one declared key, given the stored value if a row exists (`undefined` = no row). */
export function renderOne(key: SettingKey, storedValue: unknown): RenderedSetting {
  const definition = SETTINGS_REGISTRY[key];
  const base = {
    key,
    label: definition.label,
    help: definition.help,
    category: definition.category,
    appliesWhen: definition.appliesWhen,
    sensitive: definition.sensitive,
    irreversible: definition.irreversible,
  };
  if (storedValue === undefined) {
    return { ...base, value: definition.default, source: "default" };
  }
  const parsed = validateSetting(key, storedValue);
  if (parsed.ok) {
    return { ...base, value: parsed.value, source: "override" };
  }
  return {
    ...base,
    value: definition.default,
    source: "invalid-override",
    invalidOverride: { storedValue, errors: parsed.errors },
  };
}

/** Reads one override row by key, or null if none exists. */
export async function readOverrideRow(
  db: TransactionHandle,
  key: string,
): Promise<RawSettingRow | null> {
  const rows = await db.$queryRawUnsafe<RawSettingRow[]>(
    `SELECT "key", "value" FROM "settings" WHERE "key" = $1`,
    key,
  );
  return rows[0] ?? null;
}

/** Reads every override row. */
export async function readAllOverrideRows(db: TransactionHandle): Promise<RawSettingRow[]> {
  return db.$queryRawUnsafe<RawSettingRow[]>(`SELECT "key", "value" FROM "settings"`);
}

/**
 * Bumps `settings_revision` and returns the new value.
 *
 * SCHEMA.md §17.2: "Bumped in the same transaction as every settings write,
 * including a delete." Called exactly once per write operation — even
 * `patch_settings`, which can touch several keys, bumps the counter once for
 * the whole batch (§19: "one revision bump… per key sharing a batch
 * identifier" — the *event* is per key; the *revision bump* is per call).
 */
export async function bumpRevision(db: TransactionHandle): Promise<bigint> {
  const rows = await db.$queryRawUnsafe<{ revision: bigint }[]>(
    `UPDATE "settings_revision" SET "revision" = "revision" + 1 WHERE "id" = 1 RETURNING "revision"`,
  );
  const row = rows[0];
  if (!row) {
    // Unreachable in practice: the row is seeded by the settings_core
    // migration and nothing here deletes it. Guarded rather than asserted,
    // matching appendEvent's own posture on the same class of "the insert
    // that always returns a row didn't".
    throw new NotFoundError("settings_revision row is missing.", { fields: [] });
  }
  return row.revision;
}

/** One key's `from`/`to` for the `setting_change` audit payload — SCHEMA.md §3's `{set, value?}` discriminator. */
export interface SettingChangeSide {
  readonly set: boolean;
  readonly value?: unknown;
}

function sideFor(row: RawSettingRow | null): SettingChangeSide {
  return row ? { set: true, value: row.value } : { set: false };
}

/**
 * Appends the `setting_change` audit event for one key.
 *
 * `itemId` is omitted (null) — this is a system-level event, not scoped to
 * an item (SCHEMA.md §3, §17.2's own payload note). `batchId` is shared by
 * every row one call writes, so a multi-key `PATCH /settings` reads back as
 * one act rather than several unrelated ones (§19).
 */
export async function appendSettingChangeEvent(
  db: TransactionHandle,
  args: {
    readonly key: string;
    readonly before: RawSettingRow | null;
    readonly after: RawSettingRow | null;
    readonly batchId: string;
    readonly caller: Caller;
  },
): Promise<void> {
  await appendEvent(db, {
    itemId: null,
    actor: {
      actorType: args.caller.actor ? "agent" : "system",
      actorId: args.caller.actor ?? null,
      sessionId: args.caller.sessionId ?? null,
    },
    type: "setting_change",
    payload: {
      key: args.key,
      from: sideFor(args.before),
      to: sideFor(args.after),
      batch_id: args.batchId,
    },
  });
}

/** Refuses a key this build does not declare — shared by every write path. */
export function requireSettingKey(key: string): asserts key is SettingKey {
  if (!isSettingKey(key)) {
    throw new NotFoundError(`${key} is not a setting this build declares.`, { fields: ["key"] });
  }
}
