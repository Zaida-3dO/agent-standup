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
import { currentTipCommitSha } from "../state-machine/guards/artifact-tip";

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
  commitSha: string | null;
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
 *
 * **Round-currency alone is not commit-currency — see
 * `approvingArtifactAtCurrentRoundAndTip` below, which callers that also
 * care about the shipped commit should use instead.** Nothing here compares
 * `commitSha`: `review_round` is bumped by *any* artifact kind landing at a
 * higher round (this module's own `currentReviewRound` doc — "however
 * review actually happened, a fresh plan, a code_review, a commit"), so a
 * new `commit` artifact inserted at the *same* round as an already-approved
 * `code_review` does not, by itself, make that approval stale by this
 * function's reading — it is still "at the current round" even though a
 * newer, unreviewed commit is now the tip. That gap is exactly what
 * `merge.requires_approving_code_review` in `merge.ts` closes by pairing
 * this with a tip-commit check, not by widening this function's own
 * definition of "current round" (round-currency is still a real,
 * independently useful question — `evidence-at-tip.ts`'s sibling split for
 * row #17 is the same shape: "was it ever approved" stays separate from "is
 * it still current").
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
    `SELECT "id", "verdict", "reviewRound", "commitSha"
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

/**
 * Whether an **approving** artifact of `kind` exists at the item's current
 * review round **and** names the item's current tip commit — the
 * conjunction `merge.requires_approving_code_review` actually needs.
 *
 * Round-currency and commit-currency are genuinely two different axes (see
 * `hasApprovingArtifactAtCurrentRound`'s doc), and an approval can satisfy
 * one without the other: approved at the current round but for an earlier
 * commit that a newer, still-same-round `commit` artifact has since
 * superseded. Requiring both closes that gap — the equivalent, for the
 * round+commit pair, of what `evidence-at-tip.ts` already enforces for
 * `plan_review` against the tip alone.
 */
export async function hasApprovingArtifactAtCurrentRoundAndTip(
  db: TransactionHandle,
  itemId: string,
  kind: string,
): Promise<boolean> {
  const round = await currentReviewRound(db, itemId);
  const rows = await db.$queryRawUnsafe<ArtifactRow[]>(
    `SELECT "id", "verdict", "reviewRound", "commitSha"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind"
        AND "verdict" = 'approved' AND "reviewRound" = $3
      LIMIT 1`,
    itemId,
    kind,
    round,
  );
  const approval = rows[0];
  if (!approval) {
    return false;
  }
  const tip = await currentTipCommitSha(db, itemId);
  // Same reading `artifact-tip.ts`'s `latestApprovalAtTip` documents: with
  // no `commit` artifact for the item at all, tip is `null`, and an
  // approval with `commitSha: null` matches — nothing exists for it to be
  // stale against. Once a real tip exists, a `null` `commitSha` on the
  // approval is correctly refused as unverifiable against it.
  return approval.commitSha === tip;
}
