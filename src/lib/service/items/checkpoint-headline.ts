// The latest checkpoint's one-line BLUF — MILESTONES.md #108.
//
// **The question this answers.** A checkpoint is `events WHERE
// type='checkpoint'` (SCHEMA.md §4) and its prose is free text with no
// structure, so "where is this up to?" could only be answered by reading
// every checkpoint on the item in full. That is the most-asked question of
// an in-flight item and the most expensive one to answer, which is a bad
// pairing. A stored one-line summary makes it a single indexed row read.
//
// **Stored, with a fallback — not stored-or-nothing.** `events.headline` is
// optional (a checkpoint that records only prose is still a checkpoint), and
// every checkpoint written before the column existed has none. Returning
// null for those would make the read useless on exactly the corpus that
// already exists, so the fallback derives a line from the prose: its first
// non-empty line, which is where a writer of a BLUF-shaped checkpoint
// already puts it. The stored value always wins when there is one — the
// derivation is a floor, never an override.
//
// **Two entry points, because readers arrive holding different things.**
// `checkpointHeadline` takes a row and returns a line, so a reader that
// already has the checkpoint in hand — `orientation` reads the latest one
// for its own reasons — pays for no second query, and the precedence rule
// stays exercisable with no database at all. `latestCheckpointHeadline`
// makes the bounded lookup for a reader that has only an item id, which is
// the slim `get_item` read (MILESTONES.md #107). Both end at the same
// precedence rule, so the two cannot answer differently.
import type { TransactionHandle } from "../context";
/**
 * The longest a checkpoint headline may be.
 *
 * A cap rather than a convention, because the point of the field is that a
 * read can return it without returning the prose — and a "one-line BLUF"
 * that may be a paragraph gives that back. Enforced in the `checkpoint`
 * operation's input schema rather than as a column constraint: a validator
 * refuses with `invalid_input` and the offending field path, where a
 * column-length violation surfaces as a driver error nobody can act on.
 */
export const CHECKPOINT_HEADLINE_MAX_CHARS = 200;

/**
 * Reduces checkpoint prose to one line — the first non-empty line, trimmed,
 * capped, and ellipsised when the cap bites so a truncated value is visibly
 * truncated rather than silently a different sentence.
 *
 * The cap is what makes this a derivation rather than `body.split("\n")[0]`:
 * a checkpoint written as one unbroken paragraph has a "first line" that is
 * the entire checkpoint, which would hand back exactly the payload the
 * headline exists to avoid.
 *
 * Returns null for prose that is empty or entirely whitespace — there is a
 * difference between "no headline" and "an empty one", and a caller shows
 * nothing rather than an empty line.
 */
export function deriveHeadlineFromBody(body: string | null): string | null {
  if (body === null) return null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length <= CHECKPOINT_HEADLINE_MAX_CHARS) return trimmed;
    return `${trimmed.slice(0, CHECKPOINT_HEADLINE_MAX_CHARS - 1).trimEnd()}…`;
  }
  return null;
}

/**
 * Picks the headline for one checkpoint row: the stored one if it has one,
 * otherwise a line derived from its prose.
 *
 * A named function rather than a ternary at each read, so the precedence —
 * stored wins, always — is a thing that can be asserted directly rather
 * than only through a database round trip. That matters more than it looks:
 * a read that derived first and used the column only as *its* fallback
 * would return a plausible line in every case, and would be caught by
 * exactly one test, the one where the two sources disagree.
 */
export function checkpointHeadline(row: {
  headline: string | null;
  body: string | null;
}): string | null {
  if (row.headline !== null) return row.headline;
  return deriveHeadlineFromBody(row.body);
}

/**
 * The newest checkpoint on this item, reduced to one line. Null when the
 * item has no checkpoint at all, or its newest one has neither a stored
 * headline nor prose to derive one from.
 *
 * For the caller that has an item id and not a checkpoint — the slim
 * `get_item` read (MILESTONES.md #107), which carries this so that "what is
 * this" and "where is it up to" are one question rather than two calls.
 *
 * **Item-scoped, not assignment-scoped.** The same choice `orientation`
 * makes and for the same reason: a fresh session on this item wants the
 * newest resume point across every assignment that has held it, not one
 * prior holder's.
 *
 * Ordered by `id` descending rather than `ts`, also matching `orientation`:
 * `id` is monotonic per insert and breaks ties between two checkpoints
 * written in the same millisecond, which `ts` alone cannot.
 *
 * Selects `headline` as well as `body` and ends at `checkpointHeadline`, so
 * a stored headline wins here exactly as it does for a caller holding the
 * row — a version that read only `body` would silently answer with the
 * derivation even where a writer had supplied a line.
 */
export async function latestCheckpointHeadline(
  db: TransactionHandle,
  itemId: string,
): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<{ headline: string | null; body: string | null }[]>(
    `SELECT "headline", "body" FROM "Event"
     WHERE "itemId" = $1 AND "type" = 'checkpoint'::"EventType"
     ORDER BY "id" DESC LIMIT 1`,
    itemId,
  );
  const row = rows[0];
  if (!row) return null;
  return checkpointHeadline(row);
}
