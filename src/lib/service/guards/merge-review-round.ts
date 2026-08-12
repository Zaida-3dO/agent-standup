// The shared "what is the item's current review round, and is there an
// approving code_review artifact at it" primitive for #18's merge guard.
// See docs/plans/MILESTONES.md #18, SCHEMA.md §16 ("an approving
// `code-review` artifact at the current `max(artifacts.review_round)`") and
// §6 ("No `review_round` column — it's `max(artifacts.review_round)` for the
// item. Artifacts are the truth; a second copy here would drift.").
//
// Deliberately separate from `state-machine/guards/artifact-tip.ts`, not a
// reimplementation of it: that module answers "is this artifact at the
// item's tip **commit**"; this one answers "is this artifact at the item's
// current **review round**" — the review-round-scoped shape of the same
// underlying question row #17's own header points #18 at, but a different
// column, so it earns its own small module rather than overloading
// `artifact-tip.ts` with a second axis it was never asked to compare on.
import type { TransactionHandle } from "../context";

interface ReviewRoundRow {
  reviewRound: number;
}

/**
 * The item's current review round: `max(artifacts.review_round)` across
 * **every** artifact for the item, per SCHEMA.md §6 — not scoped to any one
 * `kind`, because the round advances however review actually happened
 * (a fresh `plan`, a `code_review`, a `commit`), not only by code-review
 * artifacts. Returns `1` (the column's own default, per schema.prisma) when
 * the item has no artifacts at all — nothing has moved the round yet.
 */
export async function currentReviewRound(db: TransactionHandle, itemId: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<ReviewRoundRow[]>(
    `SELECT COALESCE(MAX("reviewRound"), 1) AS "reviewRound"
       FROM "Artifact"
      WHERE "itemId" = $1`,
    itemId,
  );
  return rows[0]?.reviewRound ?? 1;
}

interface ArtifactRow {
  id: string;
  verdict: string | null;
  reviewRound: number;
}

/**
 * Whether an **approving** artifact of `kind` exists at the item's current
 * `max(review_round)`.
 *
 * Deliberately the narrow reading, matching `artifact-tip.ts`'s
 * `latestApprovalAtTip` for the tip-commit axis: an approval recorded for an
 * earlier round is not evidence for the round that's here now, even if
 * nothing about the code changed between rounds — a new round means someone
 * re-requested review, and only a review answering *that* request counts.
 */
export async function hasApprovingArtifactAtCurrentRound(
  db: TransactionHandle,
  itemId: string,
  kind: string,
): Promise<boolean> {
  const round = await currentReviewRound(db, itemId);
  const rows = await db.$queryRawUnsafe<ArtifactRow[]>(
    // `$2::"ArtifactKind"` — Postgres infers an enum type for a literal but
    // not for a bind parameter; see artifact-tip.ts's identical comment.
    `SELECT "id", "verdict", "reviewRound"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind"
        AND "verdict" = 'approved' AND "reviewRound" = $3
      LIMIT 1`,
    itemId,
    kind,
    round,
  );
  return rows.length > 0;
}
