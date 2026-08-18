// The front end's copy of one rule: how a checkpoint reduces to a line.
//
// **Why a copy and not an import.** The rule already exists server-side, in
// a module that also carries the bounded database lookup for a caller
// holding only an item id — so it imports a transaction handle, and every
// module under `src/lib/service/` is on the far side of the line the front
// end reaches through JSON only (`types.ts`'s header, and the reason
// `npm run check:db-imports` exists). Importing it here to reuse eight
// lines would put a module that transitively types the database client onto
// the client bundle's import graph, which is the precise thing that check
// exists to prevent by accident.
//
// **What stops the copy drifting.** `tests/item-detail-status.test.ts` has a
// suite ("the copy is pinned to the server's rule") that imports BOTH this
// module and the server's, feeds them the same twelve rows, and requires the
// same answer from each — plus equality of the cap.
//
// Feeding both the same rows is the part that carries the weight. Asserting
// only that each side behaves sensibly on its own would pass a one-sided
// change, which is the realistic way these drift: somebody improves one
// copy. Requiring the two to AGREE cannot. That test file is the only place
// in the front end that imports the server module, and it is safe to do so
// because the sole thing that module pulls in is a type, erased at build
// time and never reaching a bundle.
//
// The rule itself: a stored headline always wins, and prose is the floor.
// The derivation is never an override — a version that derived first and
// used the column as *its* fallback would return a plausible line in every
// case and be caught by exactly one test, the one where the two disagree.

/**
 * The longest a checkpoint headline may be — the same cap the write path
 * enforces, so a client that renders a derived line and a server that
 * stored one produce strings of the same order.
 */
export const CHECKPOINT_HEADLINE_MAX_CHARS = 200;

/**
 * Reduces checkpoint prose to one line: the first non-empty line, trimmed,
 * capped, and ellipsised when the cap bites so a truncated value is visibly
 * truncated rather than silently a different sentence.
 *
 * The cap is what makes this a derivation rather than `body.split("\n")[0]`
 * — a checkpoint written as one unbroken paragraph has a "first line" that
 * is the whole checkpoint, which hands back exactly the payload a one-line
 * headline exists to avoid.
 *
 * Null for prose that is empty or entirely whitespace: there is a
 * difference between "no headline" and "an empty one", and a caller renders
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

/** The headline for one checkpoint row: the stored one if it has one, else derived from prose. */
export function checkpointHeadline(row: {
  readonly headline: string | null;
  readonly body: string | null;
}): string | null {
  if (row.headline !== null) return row.headline;
  return deriveHeadlineFromBody(row.body);
}
