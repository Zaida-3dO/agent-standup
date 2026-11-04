// How a `field_change` event describes a value too large to copy into the ledger.
//
// Copying a field's whole before and after value onto the event is the right
// record for a small field, and small fields get exactly that. For a large one
// it is a defect: an item with a ~28,000 character `customFields` value that is
// rewritten on every edit would store ~56,000 characters of payload per edit,
// and a read of the last few events would come to 700,000 characters — over the
// response limit, which blanks a page.
//
// A large value is therefore recorded as a *summary*: that the field changed,
// how big each side was, and a short hash of each side (enough to tell two
// edits apart, and to tell "rewritten to the same content" from "really
// changed"). For an object-valued field, the top-level keys that changed are
// listed with their sizes, so "which part of the document moved" stays
// answerable without the document.
//
// Pure and dependency-free (apart from `node:crypto`) on purpose: it reads only
// the values handed to it. `scripts/shrink-field-change-events.mjs` carries a
// copy of the same rules so a one-off cleanup can shrink events that were
// written before this existed; `tests/event-summary.test.ts` holds the two
// together on a shared set of inputs.
import { createHash } from "node:crypto";

/**
 * A `field_change` whose old or new value serialises to more than this many
 * characters is summarised instead of copied. Small enough that the largest
 * ordinary field (a headline, a short body) is kept whole; large enough that
 * nothing a person types into a title is ever summarised.
 */
export const FIELD_CHANGE_INLINE_LIMIT = 2000;

/** The most changed keys a summary lists; the rest are counted in `keysOmitted`. */
export const SUMMARY_MAX_KEYS = 25;

/** Key names are cut to this length in a summary, so one odd key cannot grow it. */
export const SUMMARY_MAX_KEY_LENGTH = 100;

/** Hex characters kept from the SHA-256 digest. */
export const SUMMARY_HASH_LENGTH = 12;

export interface KeyChange {
  readonly key: string;
  readonly change: "added" | "removed" | "changed";
  /** Serialised size of the value before the edit, `null` when the key was added. */
  readonly fromSize: number | null;
  /** Serialised size of the new value, `null` when the key was removed. */
  readonly toSize: number | null;
  /** Hash of the value after the edit (before it, when the key was removed). */
  readonly hash: string;
}

export interface FieldChangeSummary {
  readonly field: string;
  readonly summarised: true;
  readonly changed: true;
  readonly fromSize: number;
  readonly toSize: number;
  readonly fromHash: string;
  readonly toHash: string;
  readonly keys?: readonly KeyChange[];
  readonly keysOmitted?: number;
}

/** What a `field_change` payload looks like when the values are small enough to keep. */
export interface FieldChangeValues {
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

/** Length of the value as JSON; `undefined` counts as `null`, which is how it is stored. */
export function serialisedSize(value: unknown): number {
  return (JSON.stringify(value) ?? "null").length;
}

/** JSON with object keys sorted, so the hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  const plain: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value) ?? "null");
  return canonicalOfPlain(plain);
}

function canonicalOfPlain(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalOfPlain).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalOfPlain(record[key])}`);
  return `{${parts.join(",")}}`;
}

/** A short, stable fingerprint of a value. Not a secret; only for telling values apart. */
export function shortHash(value: unknown): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return digest.slice(0, SUMMARY_HASH_LENGTH);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The top-level keys that differ between two object-valued sides. Returns
 * `undefined` when neither side is an object, or when one side is something
 * other than an object or null (there is no key-level story to tell).
 */
function keyChanges(
  from: unknown,
  to: unknown,
): { keys: KeyChange[]; omitted: number } | undefined {
  const fromObject = isPlainObject(from) ? from : from === null ? {} : undefined;
  const toObject = isPlainObject(to) ? to : to === null ? {} : undefined;
  if (fromObject === undefined || toObject === undefined) return undefined;
  if (!isPlainObject(from) && !isPlainObject(to)) return undefined;

  const names = [...new Set([...Object.keys(fromObject), ...Object.keys(toObject)])].sort();
  const all: KeyChange[] = [];
  for (const name of names) {
    const inFrom = Object.prototype.hasOwnProperty.call(fromObject, name);
    const inTo = Object.prototype.hasOwnProperty.call(toObject, name);
    const key = name.length > SUMMARY_MAX_KEY_LENGTH ? name.slice(0, SUMMARY_MAX_KEY_LENGTH) : name;
    if (inFrom && !inTo) {
      all.push({
        key,
        change: "removed",
        fromSize: serialisedSize(fromObject[name]),
        toSize: null,
        hash: shortHash(fromObject[name]),
      });
    } else if (!inFrom && inTo) {
      all.push({
        key,
        change: "added",
        fromSize: null,
        toSize: serialisedSize(toObject[name]),
        hash: shortHash(toObject[name]),
      });
    } else if (canonicalJson(fromObject[name]) !== canonicalJson(toObject[name])) {
      all.push({
        key,
        change: "changed",
        fromSize: serialisedSize(fromObject[name]),
        toSize: serialisedSize(toObject[name]),
        hash: shortHash(toObject[name]),
      });
    }
  }
  return {
    keys: all.slice(0, SUMMARY_MAX_KEYS),
    omitted: Math.max(0, all.length - SUMMARY_MAX_KEYS),
  };
}

/** True when either side is over the inline limit and so must be summarised. */
export function isOversizedChange(from: unknown, to: unknown): boolean {
  return (
    serialisedSize(from) > FIELD_CHANGE_INLINE_LIMIT ||
    serialisedSize(to) > FIELD_CHANGE_INLINE_LIMIT
  );
}

/** The summary payload for a change, whatever its size. Callers check `isOversizedChange` first. */
export function summariseFieldChange(
  field: string,
  from: unknown,
  to: unknown,
): FieldChangeSummary {
  const base = {
    field,
    summarised: true as const,
    changed: true as const,
    fromSize: serialisedSize(from),
    toSize: serialisedSize(to),
    fromHash: shortHash(from),
    toHash: shortHash(to),
  };
  const diff = keyChanges(from, to);
  if (diff === undefined) return base;
  return diff.omitted > 0
    ? { ...base, keys: diff.keys, keysOmitted: diff.omitted }
    : { ...base, keys: diff.keys };
}

/**
 * The payload a `field_change` event carries for this change: the plain
 * `{field, from, to}` when both values are small, a summary when either is not.
 */
export function fieldChangePayload(
  field: string,
  from: unknown,
  to: unknown,
): FieldChangeValues | FieldChangeSummary {
  return isOversizedChange(from, to) ? summariseFieldChange(field, from, to) : { field, from, to };
}
