// Whether a person has recorded the decision that this work may land —
// SCHEMA.md §6d, §16; the evidence `merge_authority = needs_approval`
// requires.
//
// ── What went wrong, and why this is a new kind ─────────────────────────
//
// `needs_approval` means "a human decides whether this lands". The gate had
// no row recording such a decision, so it read the nearest available fact:
// an approving `code_review` whose `createdByType` is `person`.
//
// Those are different acts. `createdByType` records who WROTE an artifact,
// not who permitted a merge. So the only way to satisfy a hold was to record
// a review as a person — which the guard's own refusal message told callers
// not to do, in terms, because it credits a human with a review an agent
// performed. A requirement whose only honest satisfier does not exist is not
// a requirement, and the observed effect was a hold that did not hold: an
// item held for a person's decision on a customer-facing change landed four
// minutes later, the decision never made.
//
// So the fix is not a stricter reading of the review. It is a row that says
// the thing the gate actually wants to know.
//
// ── Why this cannot become a rubber stamp ───────────────────────────────
//
// **1. Only a person can give it.** An agent recording a `merge_approval` is
// refused at the write (`record-artifact.ts`), not merely ignored here.
// Refused at the write because an artifact silently accepted and then never
// counted is worse than one rejected: the caller believes the decision was
// recorded. This is the one artifact kind whose entire meaning is *who* made
// it, so `createdByType: 'agent'` is not a valid instance of it.
//
// **2. It is scoped to a commit.** An approval names the sha it is approving
// and stops applying when the item moves past it — resolved through the same
// `tipCommitLineage` every other merge-time check uses, so a squash or rebase
// carries it forward while genuinely new work does not. A person approving
// "this item, whatever it becomes" is a standing grant, which is a different
// and much broader thing and already has its own expression:
// `merge_authority = pre_approved` on the item.
//
// **3. The escape hatches do not reach it.** `merge_override` explicitly
// never satisfies `needs_approval` (its own doc, property 4), and neither
// does `historical_verification`. Both widen what counts as *review
// evidence*; this is *authorisation*, and the boundary between those is the
// thing that makes a hold meaningful. Nothing in this module consults either.
//
// ── Round-scoping, deliberately absent ──────────────────────────────────
//
// The review clauses scope to `max(review_round)` because a review is a
// statement about a round of work. A person's decision is not: it is a
// statement about a state of the code, which the commit scope already pins
// exactly. Adding a round scope would expire an approval because a *reviewer*
// recorded another round at the same commit — invalidating a human decision
// through an act the human had no part in, and a fresh approval fetched for
// no reason a person could see.
import type { TransactionHandle } from "../context";
import { currentTipCommitSha, shaMatchesTipOrLineage, tipCommitLineage } from "./artifact-tip";

/** The artifact kind carrying a person's merge decision. */
export const MERGE_APPROVAL_KIND = "merge_approval";

interface ApprovalRow {
  id: string;
  commitSha: string | null;
  createdById: string;
  createdByType: string;
}

/** Whether a person's approval stands for the item's current tip, and who gave it. */
export interface MergeApprovalResult {
  readonly satisfied: boolean;
  /** Who approved, when satisfied — so a caller can be told the decision exists. */
  readonly approvedBy?: string;
  /**
   * A person approved, but at a commit the item has since moved past.
   * Distinguished from "never approved" because the two need different
   * things said: one needs a decision, the other needs a fresh one, and a
   * caller told the wrong one goes looking for the wrong person.
   */
  readonly staleApprovalExists: boolean;
}

/**
 * Whether a `merge_approval` recorded by a person applies to the item's
 * current tip commit.
 *
 * `createdByType = 'person'` is re-checked here even though the write path
 * already enforces it. The write guard protects the future; this protects the
 * decision being made right now, against a row inserted by any other writer —
 * a backfill, a fixture, a direct SQL statement. This is the single question
 * "may this merge without a human" rests on, and it should not be answerable
 * by a row whose type was never checked at the moment it counts.
 */
export async function personHasApprovedMerge(
  db: TransactionHandle,
  itemId: string,
): Promise<MergeApprovalResult> {
  const rows = await db.$queryRawUnsafe<ApprovalRow[]>(
    `SELECT "id", "commitSha", "createdById", "createdByType"::text AS "createdByType"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind"
        AND "createdByType" = 'person'::"HolderType"
      ORDER BY "createdAt" DESC, "seq" DESC`,
    itemId,
    MERGE_APPROVAL_KIND,
  );
  if (rows.length === 0) {
    return { satisfied: false, staleApprovalExists: false };
  }

  // The same lineage reading every other merge-time check uses. An approval
  // given at a branch tip that was then squash-merged approved the code that
  // shipped; refusing it because the forge rewrote the sha would make this
  // clause unsatisfiable in exactly the workflow it most needs to work in —
  // the failure #243 fixed for the review clauses, which would otherwise be
  // reintroduced here.
  const lineage = await tipCommitLineage(db, itemId);
  const tip = await currentTipCommitSha(db, itemId);

  // Delegated to `shaMatchesTipOrLineage` (`artifact-tip.ts`), which both
  // (a) treats a `null` `commitSha` as matching only when the item has no
  // commit artifact at all — nothing exists for it to be stale against, so
  // an unpinned approval is refused once a real tip exists, because it
  // cannot be shown to be about the code that would ship — and (b) allows
  // either side of the comparison to be an abbreviated git sha. This used
  // to be a local `appliesToTip` doing the same tip/lineage comparison by
  // exact value, which is exactly the shape that let this function refuse
  // an approval `latestApprovalAtTip` accepted for the identical row (row
  // `e09aa150`): four call sites independently deciding "is this sha at the
  // tip" is how three of them drifted out of agreement with the fourth.
  for (const row of rows) {
    if (shaMatchesTipOrLineage(row.commitSha, tip, lineage)) {
      return { satisfied: true, approvedBy: row.createdById, staleApprovalExists: false };
    }
  }
  return { satisfied: false, staleApprovalExists: true };
}
