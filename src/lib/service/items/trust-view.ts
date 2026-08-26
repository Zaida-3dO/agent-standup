// Whether a row's rendered `state` is something the system can stand behind
// — MILESTONES.md #131's second half, "marking the rows whose state is a
// lie".
//
// ── The problem, stated as data rather than as a complaint ──────────────
//
// Every imported row (`originType = 'source'`) carries a `state` copied from
// an external store at the moment of import. Nothing about that copy is
// re-checked afterwards: the row is exactly as trustworthy as it was on
// import day, and an item finished the following week by a process the
// import never modelled renders identically to one nobody has looked at
// since. §13h names the practical cost: the same reconciliation walk run
// twice, ~76k tokens each, because neither run could record its conclusion
// anywhere a third session would see. A verification IS that record.
//
// `historical_verification` (SCHEMA.md §6b, `guards/historical-verification.ts`)
// already exists as an artifact kind for exactly this claim — "someone read
// this row and checked what it says" — so this module does not invent a
// second mechanism. It reads the same table the merge guard reads, for a
// different question: not "does this satisfy a merge", but "has anyone ever
// looked".
//
// ── Why `originType` decides who NEEDS one, not `state` or `body` ────────
//
// The field notes call out `headline` disagreeing with `state`, but there is
// no honest way to detect that disagreement mechanically — "the headline
// says this is done but the state says executing" is a judgement about
// prose, not a predicate a query can evaluate. `originType = 'source'` is
// the one fact that IS mechanical: it says this row's `state` arrived by
// copy rather than by the product's own state machine, which is the entire
// reason it can be wrong in the first place. A row minted through
// `create_item` moves through `state-machine/transition.ts` on every change
// and never silently drifts from what happened; an imported row's history
// before the import boundary is exactly as reliable as the store it came
// from, which is to say: unknown until someone checks.
//
// This is deliberately narrower than "every row without a review" — a task
// created here and still `on_deck` has never had anything to lie about. The
// marker is for the specific failure mode named in the row: a stored fact
// nobody can vouch for, not an ordinary unstarted item.
import type { HolderType } from "../../claims";

/** One item's trust position — whether it needs checking, and what the newest check found. */
export interface TrustInfo {
  /**
   * True when this item's `state` was never written by this product's own
   * state machine and so cannot be taken on faith without a check.
   */
  readonly unverifiedOrigin: boolean;
  /** The newest `historical_verification` artifact against this item, or `null` if none exists. */
  readonly verification: ItemVerification | null;
}

/** The newest recorded check of an item's stored `state`. */
export interface ItemVerification {
  readonly checkedAt: string;
  readonly checkedByType: HolderType;
  readonly checkedById: string;
  /** What was inspected and what it found — the free text `record_artifact` requires for this kind. */
  readonly body: string | null;
  /** The commit the check was made against. */
  readonly commitSha: string | null;
}

/** The raw shape `$queryRawUnsafe` returns for one verification row. */
export interface RawVerificationRow {
  itemId: string;
  createdAt: Date | string;
  createdByType: HolderType;
  createdById: string;
  body: string | null;
  commitSha: string | null;
}

/**
 * The newest `historical_verification` artifact per item, for a whole page
 * at once — the same "one statement, not one per card" shape
 * `LIVE_BOARD_ASSIGNMENTS_SQL` uses, and for the same reason: a board page
 * of sixty-eight cards cannot afford sixty-eight round trips for a field
 * most of them will render as absent.
 *
 * `DISTINCT ON` rather than a window function: Postgres evaluates it
 * directly off the `(itemId, kind, createdAt)` access pattern the merge
 * guard's own lookups already use, and it reads as "one row per item" at
 * the call site without a second pass to discard the losers of a rank.
 */
export const NEWEST_VERIFICATION_SQL = `SELECT DISTINCT ON ("itemId")
     "itemId" AS "itemId",
     "createdAt" AS "createdAt",
     "createdByType" AS "createdByType",
     "createdById" AS "createdById",
     "body" AS "body",
     "commitSha" AS "commitSha"
   FROM "Artifact"
   WHERE "itemId" = ANY($1::text[]) AND "kind" = 'historical_verification'::"ArtifactKind"
   ORDER BY "itemId", "createdAt" DESC, "seq" DESC`;

function isoOrString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

/** Maps one raw row to `ItemVerification`. */
export function toItemVerification(row: RawVerificationRow): ItemVerification {
  return {
    checkedAt: isoOrString(row.createdAt),
    checkedByType: row.createdByType,
    checkedById: row.createdById,
    body: row.body,
    commitSha: row.commitSha,
  };
}

/**
 * Buckets a page's worth of raw verification rows by item id.
 *
 * A `Map`, not a mutation of entries in place, for the same reason
 * `groupBoardAssignmentsByItem` returns one: the caller decides what "no
 * verification recorded" looks like, and that must be `null` rather than a
 * missing key — "nobody has checked this" and "we did not look" are
 * different facts and must not render identically (#123's rule, applied
 * here to trust instead of ownership).
 */
export function groupVerificationsByItem(
  rows: readonly RawVerificationRow[],
): Map<string, ItemVerification> {
  const byItem = new Map<string, ItemVerification>();
  for (const row of rows) {
    // `DISTINCT ON ("itemId")` already returns at most one row per item —
    // this loop can't overwrite a winner with a loser — but `set` reads
    // honestly either way, so no ordering assumption is silently load-bearing.
    byItem.set(row.itemId, toItemVerification(row));
  }
  return byItem;
}

/**
 * Whether `originType` is the one this whole module exists to flag.
 *
 * A named predicate rather than the string comparison inlined at each call
 * site, so a reader of `get-board.ts`/`get-item-detail.ts` sees the word
 * "unverified" rather than has to know `'source'` means that.
 */
export function isUnverifiedOrigin(originType: string): boolean {
  return originType === "source";
}

/** The `originType` whose state arrived by copy — the SQL half of `isUnverifiedOrigin`. */
const UNVERIFIED_ORIGIN_SQL = `"originType" = 'source'::"OriginType"`;

/** Whether a `historical_verification` exists for the row — the SQL half of "someone has looked". */
const HAS_VERIFICATION_SQL = `EXISTS (
     SELECT 1 FROM "Artifact" a
     WHERE a."itemId" = "Item"."id"
       AND a."kind" = 'historical_verification'::"ArtifactKind"
   )`;

/** The three trust positions a board can be filtered to — see `get-board.ts`'s schema. */
export type TrustFilter = "trusted" | "unverified" | "verified";

/**
 * The `WHERE` fragment for one trust position.
 *
 * **Defined here, beside the predicate the BADGE is drawn from, on purpose.**
 * The acceptance criterion for the filter is that it agrees with the
 * marking: what a trust-filtered board returns must be exactly what renders
 * marked. Two independent spellings of "unverified" — one in a renderer and
 * one in a query — is precisely how a filter and a badge come to disagree,
 * and the disagreement would be invisible because each is individually
 * correct. So `isUnverifiedOrigin` and `UNVERIFIED_ORIGIN_SQL` sit four
 * lines apart and any change has to walk past both.
 *
 * Takes no parameters and interpolates no caller input — the three values
 * are a closed enum validated by the operation's schema before this is
 * reached, and the returned string is a constant chosen by a `switch`. There
 * is no injection surface here; nothing from the request reaches the SQL.
 *
 * `verified` is `imported AND checked` rather than merely `checked`: a row
 * created by this product's own state machine has nothing to verify, so a
 * stray `historical_verification` against one must not make it appear in a
 * list whose whole meaning is "imported rows somebody has since confirmed".
 */
export function trustCondition(filter: TrustFilter): string {
  switch (filter) {
    case "unverified":
      return `(${UNVERIFIED_ORIGIN_SQL} AND NOT ${HAS_VERIFICATION_SQL})`;
    case "verified":
      return `(${UNVERIFIED_ORIGIN_SQL} AND ${HAS_VERIFICATION_SQL})`;
    case "trusted":
      // The exact complement of `unverified`, written as its negation
      // rather than as an independently-derived condition so the two
      // provably partition the item space: every row is in exactly one of
      // them, and a row can never be missing from both.
      return `NOT (${UNVERIFIED_ORIGIN_SQL} AND NOT ${HAS_VERIFICATION_SQL})`;
  }
}
