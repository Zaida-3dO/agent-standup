// Resolving an item reference — a full UUID, or a short id that is a prefix
// of one. Ope's ask, in his own words: *"allow short id's like `422637bc`
// resolve on get urls, then we can be passing around short urls instead of
// the full id everywhere."*
//
// ── Why this is a helper and not a widened `WHERE` clause ────────────────
//
// The reads are raw SQL (`WHERE "id" = $1`), and there are several of them.
// Widening each one in place would spread the same prefix semantics —
// including the ambiguity rule below, which is the whole safety story —
// across every call site, where they could drift apart. One resolver turns
// a reference into a canonical id once; the operations keep querying by
// exact id and are otherwise unchanged.
//
// ── The ambiguity rule is the point of the feature, not a detail ─────────
//
// 8 hex characters is ~4.3 billion values, so a collision across a few
// hundred items is vanishingly unlikely — but it is not impossible, and the
// consequence of getting it wrong is silent: a short id that quietly
// resolves to the *wrong* row is strictly worse than having no short id at
// all, because nothing anywhere would say so. A caller who pasted a link
// would read the wrong item's state and act on it.
//
// So a prefix matching more than one item is a **refusal that names the
// candidates**, never a pick. That is `invalid_input` rather than
// `not_found`: the rows exist and the reference is well-formed, what failed
// is that it did not identify one of them — and the fix is in the caller's
// hands (lengthen the prefix), which is exactly what a 400 means and a 404
// does not.
import { InvalidInputError, NotFoundError } from "../errors";
import type { TransactionHandle } from "../context";

/**
 * The shortest prefix that may be used as a short id.
 *
 * Eight is not an arbitrary round number: it is the first hyphen-delimited
 * group of a UUID (`422637bc` in `422637bc-f311-…`), which is the segment a
 * person actually has to hand when they truncate one, and the segment Ope
 * named in the ask. Below it, ambiguity stops being a remote possibility
 * and becomes routine — at 4 hex characters a store of a few hundred items
 * is already near-certain to collide by the birthday bound, and a feature
 * whose refusal path fires constantly is one nobody can use.
 *
 * Longer prefixes are accepted too — anything from here up to a full UUID
 * — so a caller who copies 12 characters, or the whole thing, is never
 * told off for being more specific than the minimum.
 */
export const SHORT_ID_MIN_LENGTH = 8;

/** The length of a full UUID in its canonical hyphenated form. */
const FULL_UUID_LENGTH = 36;

/**
 * Whether `value` is a canonical hyphenated UUID.
 *
 * Anchored, and case-insensitive because Postgres renders `uuid` lowercase
 * while plenty of sources upper-case it.
 */
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is usable as a short id: hex characters and hyphens only,
 * at least `SHORT_ID_MIN_LENGTH` long, and shorter than a full UUID.
 *
 * Hyphens are allowed inside because a caller who copies the first eleven
 * characters of a UUID gets `422637bc-f3`, and refusing that would be
 * refusing the obvious thing to paste. The pattern still cannot match
 * arbitrary text, which is what keeps a genuinely unknown id on the
 * `not_found` path instead of turning it into a prefix scan.
 */
const SHORT_ID = /^[0-9a-f][0-9a-f-]*$/i;

/** Whether `reference` is a full UUID and so needs no resolution at all. */
export function isFullUuid(reference: string): boolean {
  return FULL_UUID.test(reference);
}

/**
 * Whether `reference` could be a short id — the shape test only. Says
 * nothing about whether it matches an item.
 */
export function isShortIdShape(reference: string): boolean {
  return (
    reference.length >= SHORT_ID_MIN_LENGTH &&
    reference.length < FULL_UUID_LENGTH &&
    SHORT_ID.test(reference)
  );
}

/** One candidate an ambiguous short id matched, as the refusal reports it. */
export interface ShortIdCandidate {
  readonly id: string;
  readonly title: string;
}

interface RawCandidateRow {
  readonly id: string;
  readonly title: string;
}

/**
 * The most candidates an ambiguous refusal will name.
 *
 * A cap because the message goes to a person: a prefix short enough to
 * match hundreds of rows produces a wall of text nobody reads, and the
 * count in the message already tells them the real scale. It is a display
 * bound only — the *decision* to refuse is made on whether more than one
 * row matched, never on this number.
 */
const MAX_CANDIDATES_REPORTED = 10;

/**
 * Turns an item reference into the canonical id of exactly one item.
 *
 * A full UUID is returned untouched **without a query** — the existing
 * behaviour is preserved exactly, including that an unknown-but-well-formed
 * UUID is left for the caller's own `WHERE id = $1` to miss and report.
 * That matters for more than speed: it means this helper cannot change what
 * any existing full-UUID call does, which is what makes the feature
 * additive rather than a rewrite of every read.
 *
 * Anything else that looks like a short id is resolved by prefix:
 *
 *   - exactly one match → that item's id
 *   - more than one     → `InvalidInputError` naming the candidates
 *   - none              → `NotFoundError`
 *
 * A reference that is neither a UUID nor short-id-shaped is returned as-is,
 * so the caller's own lookup produces its usual `not_found` — this helper
 * never invents a refusal for input the operation would have rejected the
 * same way anyway.
 */
export async function resolveItemId(db: TransactionHandle, reference: string): Promise<string> {
  if (isFullUuid(reference)) return reference;
  if (!isShortIdShape(reference)) return reference;

  // `LIKE` with the prefix as a *parameter*, so the reference is never
  // interpolated into SQL. `SHORT_ID` already excludes `%` and `_`, so no
  // escaping of LIKE metacharacters is needed on top — but the parameter is
  // what makes that a defence in depth rather than the only line.
  //
  // `LIMIT` is one more than the report cap: enough rows to fill the
  // message, plus one, so "there are more than we are showing" is knowable
  // without counting the whole table.
  const rows = await db.$queryRawUnsafe<RawCandidateRow[]>(
    `SELECT "id", "title" FROM "Item" WHERE "id"::text LIKE $1 ORDER BY "id" LIMIT ${MAX_CANDIDATES_REPORTED + 1}`,
    `${reference.toLowerCase()}%`,
  );

  const only = rows.length === 1 ? rows[0] : undefined;
  if (only) return only.id;

  if (rows.length === 0) {
    throw new NotFoundError(`No item's id starts with ${reference}.`, { fields: ["id"] });
  }

  const shown = rows.slice(0, MAX_CANDIDATES_REPORTED);
  const candidates: ShortIdCandidate[] = shown.map((row) => ({ id: row.id, title: row.title }));
  const more = rows.length > MAX_CANDIDATES_REPORTED;
  const listed = shown.map((row) => `${row.id} (${row.title})`).join(", ");
  throw new InvalidInputError(
    `The short id ${reference} matches more than one item: ${listed}${
      more ? ", and more" : ""
    }. Use a longer prefix, or the full id.`,
    { fields: ["id"], details: { candidates, truncated: more } },
  );
}
