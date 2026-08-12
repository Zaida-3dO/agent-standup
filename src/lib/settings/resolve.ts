// Resolution: registry defaults, plus any override that validates, frozen.
// See docs/plans/SCHEMA.md §17.3.
//
// The output is a typed snapshot rather than a lookup table —
// `snapshot.values["items.max_depth"]` is a number, not an unknown — and it
// is frozen because the service layer resolves once per call and threads
// the same object through every guard. A guard that could write to it would
// make two checks in one transaction disagree, which is exactly the failure
// resolving once was meant to remove.
import {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  isSettingKey,
  type SettingKey,
  type SettingValue,
} from "./registry";
import { formatIssues } from "./validate";

/** The resolved value of every declared key, typed per key. */
export type SettingsValues = {
  readonly [K in SettingKey]: SettingValue<K>;
};

/** A stored override that failed its key's schema (the schema tightened). */
export interface RejectedOverride {
  key: SettingKey;
  /** What was stored, kept so `/settings` can show it beside the error. */
  storedValue: unknown;
  errors: string[];
}

/** A stored override for a key this build does not declare. */
export interface UnrecognisedOverride {
  key: string;
  storedValue: unknown;
}

export interface SettingsSnapshot {
  readonly values: SettingsValues;
  /** The revision the overrides were read at. */
  readonly revision: bigint;
  /** Overrides that failed validation; the default was used instead. */
  readonly rejected: readonly RejectedOverride[];
  /** Rows for keys the registry does not declare. Inert, never deleted. */
  readonly unrecognised: readonly UnrecognisedOverride[];
}

/** One stored override row, as resolution needs to see it. */
export interface StoredOverride {
  key: string;
  value: unknown;
}

/**
 * Freezes a value and everything reachable from it.
 *
 * `Object.freeze` alone is shallow, and most settings values here are not
 * scalars — `budget.windows` is a nested map and `minting.source_globs` an
 * array. A shallow freeze would leave `snapshot.values["budget.windows"].w5h`
 * writable, which is the mutation actually worth preventing: it is reached
 * through a chain long enough that nobody notices they are writing to
 * shared state.
 *
 * Cycles are handled with a seen-set rather than assumed away. Settings
 * values arrive from `JSON.parse` of a jsonb column, which cannot produce
 * one — but the defaults are hand-written objects in the registry, and this
 * function is not the place to depend on nobody ever writing a self-
 * reference there.
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== "object") return value;
  const asObject = value as unknown as object;
  if (seen.has(asObject)) return value;
  seen.add(asObject);

  // Freeze before recursing: a cycle reaching back to this object then
  // finds it already frozen and already seen, rather than being descended
  // a second time.
  Object.freeze(asObject);
  for (const key of Reflect.ownKeys(asObject)) {
    const descriptor = Object.getOwnPropertyDescriptor(asObject, key);
    // A getter's value is whatever it returns at read time; reading it here
    // to freeze the result would both run someone's code during resolution
    // and freeze an object the getter may not own.
    if (!descriptor || !("value" in descriptor)) continue;
    deepFreeze(descriptor.value, seen);
  }
  return value;
}

/**
 * A structural copy of a value, so a snapshot never shares a mutable object
 * with the registry.
 *
 * Without this, freezing a default would freeze the registry's own object,
 * and two snapshots would share it. That is invisible in a passing test and
 * ugly in production: the first resolution silently makes a module-level
 * constant immutable for the lifetime of the process.
 */
function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => clone(entry)) as unknown as T;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = clone(entry);
  }
  return copy as unknown as T;
}

export interface ResolveInput {
  overrides: readonly StoredOverride[];
  revision: bigint;
}

/**
 * Builds the snapshot: start from the defaults, apply each override that
 * validates, freeze the result.
 *
 * The three disagreement cases in §17.3 are all decided here, and all three
 * keep the process running: an override that fails its schema falls back to
 * the default and is reported, an override for an undeclared key is inert
 * and reported, and neither is a boot failure — refusing to start because a
 * bound moved turns a configuration nit into an outage.
 */
export function resolveSettings({ overrides, revision }: ResolveInput): SettingsSnapshot {
  const values = {} as Record<SettingKey, unknown>;
  for (const key of SETTING_KEYS) {
    values[key] = clone(SETTINGS_REGISTRY[key].default);
  }

  const rejected: RejectedOverride[] = [];
  const unrecognised: UnrecognisedOverride[] = [];

  for (const override of overrides) {
    if (!isSettingKey(override.key)) {
      unrecognised.push({ key: override.key, storedValue: override.value });
      continue;
    }
    const parsed = SETTINGS_REGISTRY[override.key].schema.safeParse(override.value);
    if (parsed.success) {
      values[override.key] = clone(parsed.data);
    } else {
      rejected.push({
        key: override.key,
        storedValue: override.value,
        errors: formatIssues(parsed.error),
      });
    }
  }

  return deepFreeze({
    values: values as SettingsValues,
    revision,
    rejected,
    unrecognised,
  });
}

/** The snapshot a process with no database rows would resolve. */
export function defaultSnapshot(): SettingsSnapshot {
  return resolveSettings({ overrides: [], revision: 0n });
}
