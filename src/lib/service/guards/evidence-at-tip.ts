// Guard: an approval that exists is not enough — it has to be evidence for
// the item **as it stands now**, not as it stood at an earlier commit. See
// docs/plans/MILESTONES.md #17 ("evidence at the tip commit").
//
// This is the guard `plan-approval.ts` deliberately does not fold into
// itself: that guard asks "was this ever approved" (existence);
// this one asks "is the newest approval still valid" (currency). Registered
// on the same `(plan_review, executing)` pair so both run and both can
// reject independently, each naming its own cause. #18's merge guard reuses
// `latestApprovalAtTip` directly (SCHEMA.md §16's `merged` row — "an
// approving `code-review` artifact at the current `max(artifacts.
// review_round)`" is the review-round-scoped shape of the exact same
// question) rather than this guard, because `merged` is row #18's own
// transition to gate, not this one's.
//
// **Why this can reject even when `plan-approval.ts` passes:** a plan can be
// approved, then the branch keeps moving — a new `commit` artifact lands
// after the approval — without anyone re-requesting review. At that point
// `hasApproval` is still true (an approval row exists), but it is evidence
// for a plan that does not match what is actually there now. `appliesTo` is
// deliberately identical to `plan-approval.ts`'s, not broader: this guard
// has nothing to say about any other transition, and in particular says
// nothing about `merged`, which is row #18's to gate.
import type { Guard, GuardInput } from "../state-machine/guard";
import { guardOk, guardRejected } from "../state-machine/guard";
import { currentTipCommitSha, hasApproval, latestApprovalAtTip } from "./artifact-tip";
import {
  reviewEvidenceOverrideRemedy,
  reviewEvidenceOverrideSatisfies,
} from "./review-evidence-override";

export const evidenceAtTipGuard: Guard = {
  id: "artifact.evidence_at_tip",
  description:
    "An approved plan_review artifact must be at the item's current tip commit, not an earlier one.",
  appliesTo: (from, to) => from === "plan_review" && to === "executing",
  async check(input: GuardInput) {
    // If nothing was ever approved, that is plan-approval.ts's rejection to
    // make, not this guard's — asking "is the evidence current" when there
    // is no evidence at all would produce a confusing second rejection for
    // the same underlying fact. This guard only has something to say once an
    // approval actually exists.
    const approvedAtAll = await hasApproval(input.db, input.item.id, "plan_review");
    if (!approvedAtAll) {
      return guardOk;
    }

    const atTip = await latestApprovalAtTip(input.db, input.item.id, "plan_review");
    if (!atTip) {
      // ── The stated-reason override ──────────────────────────────────────
      //
      // Checked inside this clause rather than as a separate guard, for the
      // structural reason `merge.ts` gives for the same decision: guards are
      // AND-composed and the first rejection wins, so a new guard could only
      // ever ADD a requirement — it could never satisfy the one this clause
      // enforces. An alternative satisfier has to live where the requirement
      // lives.
      //
      // Checked only AFTER `latestApprovalAtTip` has already said no, so an
      // override is consumed only when the guard would actually have
      // refused. An override recorded on an item whose approval is properly
      // at the tip is inert — it costs nothing and, more importantly, is not
      // counted as a firing, which keeps the override count an honest
      // measure of how often this guard's default was judged wrong.
      const override = await reviewEvidenceOverrideSatisfies(input.db, input.item.id);
      if (override.satisfied) {
        return guardOk;
      }

      const tip = await currentTipCommitSha(input.db, input.item.id);
      // latestApprovalAtTip already treats an approval whose sha is a git
      // abbreviation of the tip (or of anything the tip's lineage stands in
      // for) as current — see artifact-tip.ts's `shaMatches`. So a rejection
      // reaching here is never "the same commit, spelled at two lengths"; it
      // is either a real move (the plan changed after approval, and
      // re-review is the correct remedy) or an approval that never recorded
      // a commit at all (unverifiable, and re-review is also the only way
      // out, but for a different reason worth naming honestly rather than
      // implying the plan moved when it may not have).
      return guardRejected(
        (tip
          ? `The most recent plan_review approval is not for the current tip commit (${tip}). ` +
            "The plan has moved since it was approved — get it re-reviewed."
          : "The most recent plan_review approval does not record which commit it applies to, " +
            "so it cannot be trusted against the current tip. Get the plan re-reviewed.") +
          // Named here because without it this refusal is absolute: a caller
          // who judges the plan has not materially moved has no way to say so
          // and no way past. The block still stands — it is a block someone
          // can pass only by writing down why, and being counted for it.
          ` ${reviewEvidenceOverrideRemedy(evidenceAtTipGuard.id, tip !== null)}`,
        { fields: ["state"] },
      );
    }
    return guardOk;
  },
};
