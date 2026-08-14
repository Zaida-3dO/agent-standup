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
// **Where the row comes from is the reader's business, not this module's.**
// It takes a row and returns a line, so a reader that already has the
// checkpoint in hand — `orientation` reads the latest one for its own
// reasons — pays for no second query, and this module needs no database
// access at all to be exercised.
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
