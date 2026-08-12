// Guards — merge. See docs/plans/MILESTONES.md #18, SCHEMA.md §16:
//
//   | `merged` | Plus `commit_sha`, plus an approving `code-review` artifact
//   |          | at the current `max(artifacts.review_round)`; plus an
//   |          | approving `visual-review` artifact iff `needs_visual_review`;
//   |          | plus an auth check per `merge_authority`. |
//
// Four required-field checks, one per clause, registered separately so a
// rejection always names the specific clause that failed rather than one
// guard's ambiguous "no" — the same shape rows #16/#17/#19 already use for
// `blocked`/`paused` and the artifact checks. All four `appliesTo` entering
// `merged`, matching SCHEMA.md §16's table, which reads by "Entering", not by
// a specific `(from, to)` pair.
//
// Reuses row #17's `artifact-tip.ts` primitives directly for the commit-sha
// and tip-staleness questions (its own header: "#18's merge guard needs
// exactly this same comparison") rather than reimplementing them, and adds
// `merge-review-round.ts` alongside for the question `artifact-tip.ts` does
// not answer on its own — round-scoped, not commit-scoped.
//
// **Round-currency and commit-currency are checked together, not
// separately** — the composition gap review round 1 found. Round-scoping
// alone lets a *newer, unreviewed* commit land at the same round as an
// already-approved review, so `merge.requires_approving_code_review` and
// `merge.requires_authorisation`'s `needs_approval` branch both require
// their approving artifact to match the current review round **and** the
// current tip commit (`hasApprovingArtifactAtCurrentRoundAndTip` /
// `hasPersonApprovedCodeReviewAtCurrentRoundAndTip`) — see each function's
// own doc for the exact scenario this closes.
import { guardOk, guardRejected, type Guard, type GuardInput } from "../state-machine/guard";
import {
  currentTipCommitSha,
  hasApproval,
  latestApprovalAtTip,
} from "../state-machine/guards/artifact-tip";
import { currentReviewRound, hasApprovingArtifactAtCurrentRoundAndTip } from "./merge-review-round";

const MERGE_AUTHORITIES = new Set(["pre_approved", "needs_approval", "agent_judgement"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Requires evidence of a commit before an item can merge — SCHEMA.md §16's
 * "Plus `commit_sha`". `items` has no stored `commit_sha` column (§6 — "Store
 * facts, derive volatiles"; the fact lives on the `commit`-kind `Artifact`
 * row, exactly what `currentTipCommitSha` reads), so "has a commit_sha" is
 * "has at least one `commit` artifact" — the same tip primitive row #17
 * built, reused rather than reimplemented.
 */
export const mergeRequiresCommitGuard: Guard = {
  id: "merge.requires_commit",
  description: "Entering merged requires a commit artifact recording the commit_sha.",
  appliesTo: (_from, to) => to === "merged",
  async check(input: GuardInput) {
    const tip = await currentTipCommitSha(input.db, input.item.id);
    if (!tip) {
      return guardRejected(
        "No commit_sha recorded for this item — record a commit artifact before merging.",
        { fields: ["state"] },
      );
    }
    return guardOk;
  },
};

/**
 * Requires an approving `code_review` artifact **at the item's current
 * review round, and naming the item's current tip commit** — SCHEMA.md
 * §16's "an approving `code-review` artifact at the current
 * `max(artifacts.review_round)`", read together with the tip-commit
 * requirement `merge.requires_commit` already enforces, because the two are
 * not independent: review round 1 found that checking round-currency alone
 * lets a *newer, unreviewed* commit land at the same round as an
 * already-approved review — the approval is still "at the current round" by
 * that reading even though it names a commit the tip has since moved past.
 * §16's own point in naming `max(review_round)` is "was this reviewed
 * recently, not stale" — and a review that is current-round but not
 * current-*commit* has not actually reviewed what would ship. Pairing both
 * checks (`hasApprovingArtifactAtCurrentRoundAndTip`) is what makes "current
 * round" mean what it is meant to: the round that reviewed *this* commit.
 *
 * Two distinct failure causes, kept as two distinct rejections rather than
 * folded into one guard's ambiguous "no" — the same split row #17 makes
 * between `plan-approval.ts` (existence) and `evidence-at-tip.ts`
 * (currency): `hasApproval` is missing entirely → this guard rejects with
 * its own id; approved but not at the current round-and-tip → this guard
 * also rejects, naming the same id either way, because unlike the
 * plan-review case there is no separate guard registered on this exact
 * clause to hand the second cause to — SCHEMA.md §16 states this as a
 * single required clause, not two.
 */
export const mergeRequiresApprovingCodeReviewGuard: Guard = {
  id: "merge.requires_approving_code_review",
  description:
    "Entering merged requires an approving code_review artifact at the item's current review round and tip commit.",
  appliesTo: (_from, to) => to === "merged",
  async check(input: GuardInput) {
    const approvedAtAll = await hasApproval(input.db, input.item.id, "code_review");
    if (!approvedAtAll) {
      return guardRejected(
        "No approved code_review artifact for this item — get the code reviewed and approved before merging.",
        { fields: ["state"] },
      );
    }
    const atCurrentRoundAndTip = await hasApprovingArtifactAtCurrentRoundAndTip(
      input.db,
      input.item.id,
      "code_review",
    );
    if (!atCurrentRoundAndTip) {
      const round = await currentReviewRound(input.db, input.item.id);
      const tip = await currentTipCommitSha(input.db, input.item.id);
      return guardRejected(
        `The most recent code_review approval is not for the current review round (${round}) ` +
          `and tip commit (${tip ?? "none"}). The item has moved since it was approved — get it re-reviewed.`,
        { fields: ["state"] },
      );
    }
    return guardOk;
  },
};

/**
 * Requires an approving `visual_review` artifact **iff** the item's
 * `needs_visual_review` flag is set — SCHEMA.md §16's "plus an approving
 * `visual-review` artifact iff `needs_visual_review`". An item that does not
 * need visual review has nothing for this guard to check, so it passes
 * unconditionally — the `iff` cuts both ways: required when the flag is set,
 * and *not* required (never checked at all) when it is not.
 *
 * Uses the tip-scoped `latestApprovalAtTip`, not the round-scoped helper
 * above, on purpose: SCHEMA.md §16 states this clause with no
 * `max(review_round)` qualifier, unlike the code-review clause immediately
 * before it in the same row — a plain "an approving `visual-review`
 * artifact", which reads as needing to be current for the item as it stands
 * now (the tip commit), not scoped to a review round that visual review does
 * not itself participate in incrementing.
 */
export const mergeRequiresVisualReviewGuard: Guard = {
  id: "merge.requires_visual_review",
  description:
    "Entering merged requires an approving visual_review artifact at the item's tip commit, when needs_visual_review is set.",
  appliesTo: (_from, to) => to === "merged",
  async check(input: GuardInput) {
    if (!input.item.needsVisualReview) {
      return guardOk;
    }
    const approvedAtAll = await hasApproval(input.db, input.item.id, "visual_review");
    if (!approvedAtAll) {
      return guardRejected(
        "This item needs visual review and has no approved visual_review artifact — get it visually reviewed before merging.",
        { fields: ["state"] },
      );
    }
    const atTip = await latestApprovalAtTip(input.db, input.item.id, "visual_review");
    if (!atTip) {
      const tip = await currentTipCommitSha(input.db, input.item.id);
      return guardRejected(
        tip
          ? `The most recent visual_review approval is not for the current tip commit (${tip}). ` +
              "The item has moved since it was visually approved — get it re-reviewed."
          : "The most recent visual_review approval does not record which commit it applies to, " +
              "so it cannot be trusted against the current tip. Get it re-reviewed.",
        { fields: ["state"] },
      );
    }
    return guardOk;
  },
};

/**
 * Enforces "who may authorise" — SCHEMA.md §16's "plus an auth check per
 * `merge_authority`" and §1.3's three values:
 *
 *   - `pre_approved`    — merge when done, don't ask. Nothing further required.
 *   - `needs_approval`  — always block on a human. **A guard, not a
 *     transition ban**: every `(from, to)` pair stays legal (guard.ts's own
 *     header — "never refuse a pair outright"), so this rejects until the
 *     required evidence exists rather than making `merged` unreachable for
 *     the item. §16 has no artifact kind for "a human approved the merge" —
 *     the nearest recorded fact is the approving `code_review` artifact this
 *     same transition already requires, so this clause is satisfied by that
 *     artifact having been recorded by a **person**, not an agent
 *     (`created_by_type`), which is the one place §16's requirement actually
 *     has a row to point at. **Deliberately the same artifact
 *     `merge.requires_approving_code_review` requires — scoped to the
 *     current review round AND the current tip commit, not "a person ever
 *     approved any round"** — see
 *     `hasPersonApprovedCodeReviewAtCurrentRoundAndTip`'s own doc for the two
 *     composition bugs this closes: without the round scope, a person's
 *     approval at an earlier round and an agent-only approval at the current
 *     round could each satisfy a different one of these two guards; without
 *     the tip scope too, a person's approval could sit at the current round
 *     but for a commit a newer, same-round commit has since superseded.
 *     Either gap lets the item merge with no human having reviewed what
 *     actually shipped.
 *   - `agent_judgement` — DECISIONS.md §9: "the agent decides at the gate
 *     ... and must record a one-line rationale". No schema column or event
 *     payload carries this yet (row #27, the transition operation itself,
 *     is what will eventually write the `merge` event) — read the same way
 *     `blocked_reason`/`pause_reason` are read here: a caller-supplied field
 *     alongside the transition request, `merge_rationale`.
 */
export const mergeRequiresAuthorisationGuard: Guard = {
  id: "merge.requires_authorisation",
  description: "Entering merged requires evidence matching the item's merge_authority.",
  appliesTo: (_from, to) => to === "merged",
  async check(input: GuardInput) {
    const authority = input.item.mergeAuthority;
    if (!MERGE_AUTHORITIES.has(authority)) {
      return guardRejected(`Unrecognised merge_authority: ${authority}.`, { fields: ["state"] });
    }

    if (authority === "pre_approved") {
      return guardOk;
    }

    if (authority === "needs_approval") {
      const approvedByPerson = await hasPersonApprovedCodeReviewAtCurrentRoundAndTip(
        input.db,
        input.item.id,
      );
      if (!approvedByPerson) {
        return guardRejected(
          "merge_authority is needs_approval — a person must record the approving code_review " +
            "artifact at the current review round and tip commit before this item can merge.",
          { fields: ["state"] },
        );
      }
      return guardOk;
    }

    // agent_judgement
    if (!isNonEmptyString(input.fields.merge_rationale)) {
      return guardRejected(
        "merge_authority is agent_judgement — merging requires a recorded one-line merge_rationale.",
        { fields: ["merge_rationale"] },
      );
    }
    return guardOk;
  },
};

interface ApprovingArtifactRow {
  createdByType: string;
  commitSha: string | null;
}

/**
 * Whether the item's approving `code_review` artifact **at the current
 * review round and the current tip commit** was recorded by a person rather
 * than an agent.
 *
 * Deliberately scoped to round **and** tip, not "any approved round ever" —
 * two composition bugs, found the same way (review round 1), both closed
 * here:
 *
 *   1. An earlier version of this function checked every round, on the
 *      reasoning that "an agent could not launder a person's earlier
 *      sign-off through a private route this guard fails to see." That
 *      reasoning was backwards: it let the *opposite* case through
 *      unnoticed — a person's approval from an *earlier* round while the
 *      current round was only ever approved by an agent, letting the item
 *      merge with no human having reviewed the code that actually shipped.
 *   2. Scoping to round alone is still not enough, because round-currency
 *      and commit-currency are different axes (`merge-review-round.ts`'s
 *      `hasApprovingArtifactAtCurrentRoundAndTip` doc): a person's approval
 *      could sit at the current round but for a commit a newer,
 *      still-same-round `commit` artifact has since superseded, while a
 *      *different*, agent-authored artifact at that same round is the one
 *      that actually matches the tip and satisfies
 *      `merge.requires_approving_code_review`. Requiring the person's
 *      approval to match round **and** tip ties this check to the exact
 *      same artifact that guard requires, so there is no artifact it
 *      accepts that this one could accept a different one for instead.
 *
 * See `tests/merge-guards.test.ts`'s "person-approved at an earlier round,
 * agent-only at the current round" case for regression (1), and the tip
 * commit case for regression (2).
 */
async function hasPersonApprovedCodeReviewAtCurrentRoundAndTip(
  db: GuardInput["db"],
  itemId: string,
): Promise<boolean> {
  const round = await currentReviewRound(db, itemId);
  const rows = await db.$queryRawUnsafe<ApprovingArtifactRow[]>(
    `SELECT "createdByType", "commitSha"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = 'code_review' AND "verdict" = 'approved'
        AND "createdByType" = 'person' AND "reviewRound" = $2
      LIMIT 1`,
    itemId,
    round,
  );
  const approval = rows[0];
  if (!approval) {
    return false;
  }
  const tip = await currentTipCommitSha(db, itemId);
  return approval.commitSha === tip;
}

/** All four merge guards, for the registration module to install in one call. */
export const MERGE_GUARDS: readonly Guard[] = [
  mergeRequiresCommitGuard,
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresVisualReviewGuard,
  mergeRequiresAuthorisationGuard,
];
