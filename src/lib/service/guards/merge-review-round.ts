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
import { currentTipCommitSha, shaMatchesTipOrLineage, tipCommitLineage } from "./artifact-tip";
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

interface KindAtRoundRow {
  kind: string;
}

/**
 * The artifact **kinds** sitting at `round` for the item, newest first.
 *
 * Exists only so a refusal can name the thing that moved the round.
 * `currentReviewRound` above answers "what round is it" with a bare number.
 * A bare number is the whole of what a refusal resting on it can say, and
 * that is precisely what makes the round limb easy to misdiagnose. "The item is at round 2" is true and useless; "round 2 was set by a
 * `check_run`" is the sentence that ends the investigation, because it names
 * a row the reader can go and look at and tells them nothing about the code
 * changed.
 *
 * Purely diagnostic: **no guard verdict depends on this**, and nothing here
 * is consulted before deciding to refuse. It runs only on a branch that has
 * already decided to refuse, to choose words.
 *
 * Not scoped by verdict or by kind, deliberately — the point is to report
 * whatever actually carries the max round, including the non-review kinds
 * (`commit`, `check_run`, `historical_verification`) that are the usual
 * cause and the ones a reader is least likely to suspect.
 */
export async function artifactKindsAtRound(
  db: TransactionHandle,
  itemId: string,
  round: number,
): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<KindAtRoundRow[]>(
    `SELECT DISTINCT "kind"::text AS "kind", MAX("seq") AS "seq"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "reviewRound" = $2
      GROUP BY "kind"
      ORDER BY MAX("seq") DESC`,
    itemId,
    round,
  );
  return rows.map((row) => row.kind);
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
      ORDER BY "createdAt" DESC, "seq" DESC`,
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
  const resolution = await resolveApprovingArtifactAtCurrentRoundAndTip(db, itemId, kind);
  return resolution.matched ?? null;
}

/**
 * The same question as `approvingArtifactAtCurrentRoundAndTip`, answered with
 * **which of its three conjuncts failed** instead of a bare `null`.
 *
 * This function decides nothing. `matched` is exactly the row the older
 * function returns — same query, same ordering, same comparison — so a caller
 * that reads only `matched` is byte-identical in behaviour to one calling the
 * older function, which is why the older function is now a wrapper over this
 * one rather than a parallel implementation. **Everything else on the result
 * is words for a refusal that has already been decided.**
 *
 * It exists because "not at the current round and tip" is a conjunction of
 * three genuinely different situations, and collapsing them to `null` threw
 * away the only fact a reader needed:
 *
 * - **`none`** — no approving artifact of `kind` at this round at all. The
 *   review may exist at another round, or not exist.
 * - **`round`** — an approving artifact exists, but at a lower round. Nothing
 *   is stale; the item's round moved out from under a review that was never
 *   compared against a commit at all. `roundSetBy` names the kinds sitting at
 *   the current round, which is the sentence that identifies the culprit:
 *   the round is `MAX(reviewRound)` across **every** kind, so a `check_run`
 *   or a `commit` recorded after an approval silently demotes it.
 * - **`sha`** — an approving artifact exists at the right round, but its
 *   `commitSha` does not match the tip or its lineage. This is the only one
 *   of the three that is actually staleness, and the only one where "the item
 *   moved since it was approved" is a true sentence.
 *
 * The distinction is not cosmetic. A refusal that says "not for the current
 * review round (2) and last recorded commit (abc123)" describes all three at
 * once and therefore describes none of them: a reader hunting a sha mismatch
 * when the real cause was a `check_run` bumping the round finds nothing wrong
 * with the sha, because nothing is wrong with the sha.
 */
export interface ApprovalResolution {
  /**
   * The qualifying row, or `null`. **The complete verdict** — every other
   * field on this object is diagnostic and must not be consulted to decide
   * whether to allow. `null` here is exactly the `null` the wrapper returns.
   */
  matched: ArtifactRow | null;
  /**
   * Which conjunct failed, or `null` when `matched` is non-null. Ordered by
   * how the check actually proceeds: existence, then round, then sha.
   */
  failedOn: "none" | "round" | "sha" | null;
  /** The item's current review round — `MAX(reviewRound)` across all kinds. */
  round: number;
  /** The item's tip commit sha, or `null` when no `commit` artifact exists. */
  tip: string | null;
  /**
   * The artifact kinds sitting at the current round, newest first. Populated
   * only for `failedOn: "round"`, where naming them is the entire point.
   */
  roundSetBy: string[];
  /**
   * Rounds at which an approving artifact of `kind` does exist, with the sha
   * each names. Populated only for `failedOn: "round"` — it is what lets a
   * refusal say "your review is at round 1" rather than leaving the reader to
   * discover that themselves.
   */
  approvalsAtOtherRounds: { round: number; commitSha: string | null }[];
  /**
   * The sha the newest same-round approval names, for `failedOn: "sha"`.
   * `null` both when no approval names one and when this is not the sha case.
   */
  reviewedSha: string | null;
}

export async function resolveApprovingArtifactAtCurrentRoundAndTip(
  db: TransactionHandle,
  itemId: string,
  kind: string,
): Promise<ApprovalResolution> {
  const round = await currentReviewRound(db, itemId);
  const rows = await approvingArtifactsAtRound(db, itemId, kind, round);
  if (rows.length === 0) {
    // Nothing approving at THIS round. Distinguish "approved at an earlier
    // round and demoted" from "never approved" — the caller's refusal reads
    // completely differently for the two, and only the first one has a cheap
    // remedy (re-record the review at the current round).
    const elsewhere = await approvingArtifactsAtOtherRounds(db, itemId, kind, round);
    if (elsewhere.length === 0) {
      return {
        matched: null,
        failedOn: "none",
        round,
        tip: await currentTipCommitSha(db, itemId),
        roundSetBy: [],
        approvalsAtOtherRounds: [],
        reviewedSha: null,
      };
    }
    return {
      matched: null,
      failedOn: "round",
      round,
      tip: await currentTipCommitSha(db, itemId),
      roundSetBy: await artifactKindsAtRound(db, itemId, round),
      approvalsAtOtherRounds: elsewhere,
      reviewedSha: null,
    };
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
  // Delegated to `shaMatchesTipOrLineage` (`artifact-tip.ts`) rather than a
  // direct `=== tip || lineage.has(...)` comparison — that comparison is
  // exact-value only, blind to a `commitSha` recorded as a git abbreviation
  // of the tip. Row `e09aa150` proved this concretely: the same approval
  // that `latestApprovalAtTip` matched (routed through `shaMatches`) was
  // refused here while this function still compared shas directly.
  const matched = rows.find((row) => shaMatchesTipOrLineage(row.commitSha, tip, lineage)) ?? null;
  if (matched) {
    return {
      matched,
      failedOn: null,
      round,
      tip,
      roundSetBy: [],
      approvalsAtOtherRounds: [],
      reviewedSha: matched.commitSha,
    };
  }
  // Approving artifacts exist at the right round; none is at the tip. This is
  // the genuine staleness case — the one place the word "stale" is honest.
  return {
    matched: null,
    failedOn: "sha",
    round,
    tip,
    roundSetBy: [],
    approvalsAtOtherRounds: [],
    reviewedSha: rows[0]?.commitSha ?? null,
  };
}

interface OtherRoundRow {
  reviewRound: number;
  commitSha: string | null;
}

/**
 * Approving artifacts of `kind` at rounds **other than** `round`, newest
 * first. Diagnostic only, and queried only once the current round has already
 * come up empty — it answers "so where IS the review, then", which is the
 * question a reader asks next and would otherwise answer by hand.
 */
async function approvingArtifactsAtOtherRounds(
  db: TransactionHandle,
  itemId: string,
  kind: string,
  round: number,
): Promise<{ round: number; commitSha: string | null }[]> {
  const rows = await db.$queryRawUnsafe<OtherRoundRow[]>(
    `SELECT "reviewRound", "commitSha"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind"
        AND "reviewRound" <> $3 AND "verdict" = ANY($4::"Verdict"[])
      ORDER BY "reviewRound" DESC, "createdAt" DESC, "seq" DESC`,
    itemId,
    kind,
    round,
    APPROVING_VERDICTS,
  );
  return rows.map((row) => ({ round: row.reviewRound, commitSha: row.commitSha }));
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
