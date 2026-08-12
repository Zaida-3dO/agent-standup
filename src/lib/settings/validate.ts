// The one validator. Everything that stores a settings-shaped value goes
// through it: a write to `settings`, resolution reading an override back,
// and the two per-entity override columns (`machines.source_globs`,
// `accounts.budget_windows`).
//
// One function rather than one per place, because SCHEMA.md §17.7's rule is
// that an override is a different *place* and never a different *type*. Two
// validators would be two types the moment one of them was edited.
import type { z } from "zod";
import { SETTINGS_REGISTRY, isSettingKey, type SettingKey, type SettingValue } from "./registry";

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Renders a Zod error as flat, human-readable lines. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Validates a candidate value against the schema of `key`.
 *
 * Refuses an unknown key rather than accepting it: at a write surface that
 * is the whole point (a typo must not become an inert row nobody reads
 * again). Resolution handles a *stored* unknown key separately — a row for
 * an undeclared key is inert and listed, not deleted (§17.3).
 */
export function validateSetting<K extends SettingKey>(
  key: K,
  value: unknown,
): ValidationResult<SettingValue<K>>;
export function validateSetting(key: string, value: unknown): ValidationResult<unknown>;
export function validateSetting(key: string, value: unknown): ValidationResult<unknown> {
  if (!isSettingKey(key)) {
    return { ok: false, errors: [`${key} is not a setting this build declares`] };
  }
  const parsed = SETTINGS_REGISTRY[key].schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: formatIssues(parsed.error) };
}

/**
 * The per-entity override columns, and the registry key each one overrides.
 *
 * Closed, and deliberately so: SCHEMA.md §17.7 states the rule as *two uses
 * and the door is closed to a third without an argument*. Adding a member
 * here is that argument being made in the one place a reviewer will see it,
 * rather than a nullable column appearing on a table and being resolved
 * ad hoc at its single read site.
 */
export const OVERRIDE_COLUMNS = {
  "machines.source_globs": "minting.source_globs",
  "accounts.budget_windows": "budget.windows",
} as const satisfies Record<string, SettingKey>;

export type OverrideColumn = keyof typeof OVERRIDE_COLUMNS;

export type OverriddenKey<C extends OverrideColumn> = (typeof OVERRIDE_COLUMNS)[C];

export function isOverrideColumn(column: string): column is OverrideColumn {
  return Object.prototype.hasOwnProperty.call(OVERRIDE_COLUMNS, column);
}

/**
 * Validates a per-entity override column's value — by looking up the
 * registry key it overrides and calling `validateSetting`. This is the
 * mechanism that makes "validated by the same registry validator" a
 * property of the code rather than a claim in a document: there is no
 * schema here to drift from the registry's, only a lookup.
 *
 * `null` means "this entity does not override", which is always legal and
 * is what makes the column an override rather than a second setting.
 */
export function validateOverrideColumn<C extends OverrideColumn>(
  column: C,
  value: unknown,
): ValidationResult<SettingValue<OverriddenKey<C>> | null>;
export function validateOverrideColumn(column: string, value: unknown): ValidationResult<unknown>;
export function validateOverrideColumn(column: string, value: unknown): ValidationResult<unknown> {
  if (!isOverrideColumn(column)) {
    return { ok: false, errors: [`${column} is not a per-entity override column`] };
  }
  if (value === null) return { ok: true, value: null };
  return validateSetting(OVERRIDE_COLUMNS[column], value);
}

/**
 * Resolves a per-entity override against a snapshot value: the override
 * where the entity carries one, the global setting otherwise. The single
 * `COALESCE` §17.7 says this mechanism costs, expressed once so its two
 * uses cannot disagree about what null means.
 */
export function resolveOverride<T>(entityValue: T | null | undefined, globalValue: T): T {
  return entityValue === null || entityValue === undefined ? globalValue : entityValue;
}
