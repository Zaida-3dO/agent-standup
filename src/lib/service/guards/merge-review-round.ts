// The shared "what is the item's current review round, and is there an
// approving code_review artifact at it" primitive for #18's merge guard.
// See docs/plans/MILESTONES.md #18, SCHEMA.md §16 ("an approving
// `code-review` artifact at the current `max(artifacts.review_round)`") and
// §6 ("No `review_round` column — it's `max(artifacts.review_round)` for the
// item. Artifacts are the truth; a second copy here would drift.").
//
// Deliberately separate from `./artifact-tip.ts`, not a reimplementation of
// it: that module answers "is this artifact at the item's tip **commit**";
// this one answers "is this artifact at the item's current **review
// round**" — the review-round-scoped shape of the same underlying question
// row #17's own header points #18 at, but a different column, so it earns
// its own small module rather than overloading `artifact-tip.ts` with a
// second axis it was never asked to compare on.
import type { TransactionHandle } from "../context";
import { currentTipCommitSha, tipCommitLineage } from "./artifact-tip";
import { APPROVING_VERDICTS } from "../../verdicts";

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

export interface ArtifactRow {
  id: string;
  verdict: string | null;
  reviewRound: number;
  commitSha: string | null;
  followUpItemId: string | null;
  createdByType: string;
  /**
   * The review's raw `findings` document, straight from the jsonb column and
   * deliberately untyped here.
   *
   * Selected because the merge gate now grades severities
   * (`./merge-findings.ts`), and it has to grade **the artifact it is
   * actually resting on** — the one this module resolves. Fetching findings
   * in a separate query would reintroduce exactly the "two questions, two
   * artifacts" divergence this row's own doc exists to prevent: the gate
   * could rest on one review while grading another's findings.
   *
   * `unknown` rather than `Finding[]` on purpose. This is an untrusted
   * column value — rows predate the validator, and jsonb holds whatever was
   * written — so it is parsed by `parseFindings` at the point of use rather
   * than asserted here. A cast would make a claim the database does not
   * guarantee.
   */
  findings: unknown;
}

/**
 * Every **approving** artifact of `kind` at `round` for the item, newest
 * first.
 *
 * "Approving" is the tiered set (`../../verdicts.ts`), not the single label
 * `'approved'`: `lgtm`, `lgtm_with_nits` and `lgtm_with_followups` are all
 * approvals (SCHEMA.md §6a). `approved` stays in the set, so every decision
 * this module made before the tiering landed it makes identically after.
 *
 * Ordered, where the previous shape was a bare `LIMIT 1` with no `ORDER BY`.
 * Two approving artifacts can exist at the same round and tip — a first
 * review deferring findings, then a follow-up review finding it clean — and
 * "whichever Postgres happened to return" is not an answer a merge decision
 * can rest on. Newest-first means the most recent word on the change is the
 * one that counts, which is the only reading under which re-reviewing
 * something can ever change its outcome.
 */
async function approvingArtifactsAtRound(
  db: TransactionHandle,
  itemId: string,
  kind: string,
  round: number,
): Promise<ArtifactRow[]> {
  return db.$queryRawUnsafe<ArtifactRow[]>(
    // `$2::"ArtifactKind"` / `$4::"Verdict"[]` — Postgres infers an enum type
    // for a literal but not for a bind parameter; see artifact-tip.ts's
    // identical comment.
    `SELECT "id", "verdict", "reviewRound", "commitSha", "followUpItemId", "createdByType",
            "findings"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind"
        AND "reviewRound" = $3 AND "verdict" = ANY($4::"Verdict"[])
      ORDER BY "createdAt" DESC, "id" DESC`,
    itemId,
    kind,
    round,
    APPROVING_VERDICTS,
  );
}

/**
 * The approving artifact of `kind` the merge gate is actually relying on:
 * newest, at the item's current review round, and naming the current tip
 * commit — or `null` if no artifact satisfies all three.
 *
 * Exported as a **row** rather than only as a boolean because more than one
 * question is asked of that artifact: whether it exists at all
 * (`hasApprovingArtifactAtCurrentRoundAndTip`), whether a person recorded it
 * (`merge.requires_authorisation`), and — new with the tiered vocabulary —
 * which tier its verdict is and whether it links a follow-up
 * (`merge.requires_linked_followup`). Handing each of those its own query
 * would let them silently disagree about *which* artifact they were talking
 * about; resolving the artifact once and asking it three things cannot.
 */
export async function approvingArtifactAtCurrentRoundAndTip(
  db: TransactionHandle,
  itemId: string,
  kind: string,
): Promise<ArtifactRow | null> {
  const round = await currentReviewRound(db, itemId);
  const rows = await approvingArtifactsAtRound(db, itemId, kind, round);
  if (rows.length === 0) {
    return null;
  }
  const tip = await currentTipCommitSha(db, itemId);
  // "At the tip" is the tip **or any sha the tip was declared a rewrite of**
  // — `tipCommitLineage`'s doc carries the full reasoning. In short: under a
  // squash merge the landed sha does not exist until the merge happens, so
  // demanding a review against it refuses every honest caller and detects no
  // real staleness. Only shas a `commit` artifact explicitly recorded as
  // superseded join the comparison, so a commit carrying genuinely new work
  // still invalidates earlier approvals exactly as before.
  //
  // Same reading `artifact-tip.ts`'s `latestApprovalAtTip` documents and for
  // the same reason: with no `commit` artifact for the item at all, tip is
  // `null` and an approval with `commitSha: null` matches — nothing exists
  // for it to be stale against. Once a real tip exists, a `null` `commitSha`
  // on the approval is correctly refused as unverifiable against it.
  //
  // Walks the list rather than checking only `rows[0]`: "the newest
  // approval" and "the newest approval that is at the tip" are different
  // questions, and collapsing them would answer the wrong one whenever a
  // newer approval sits at the same round but an older commit.
  const lineage = await tipCommitLineage(db, itemId);
  return (
    rows.find(
      (row) => row.commitSha === tip || (row.commitSha !== null && lineage.has(row.commitSha)),
    ) ?? null
  );
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
  const rows = await approvingArtifactsAtRound(db, itemId, kind, round);
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
  return (await approvingArtifactAtCurrentRoundAndTip(db, itemId, kind)) !== null;
}
