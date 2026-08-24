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
// already-approved review, so `merge.requires_approving_code_review`
// requires its approving artifact to match the current review round **and**
// the current tip commit (`approvingArtifactAtCurrentRoundAndTip`) — see
// that function's own doc for the exact scenario this closes.
//
// **The severity clause reads the artifact the gate came to rest on**, not a
// separately-queried "latest review" — `./merge-findings.ts`. Resolving the
// approving row once and asking it several questions is what stops two
// clauses reasoning about two different artifacts, which is the shape both
// regressions above took.
//
// **Authorisation is a different question from review, and reads a different
// row.** `merge.requires_authorisation`'s `needs_approval` branch reads a
// person-recorded `merge_approval` (`./merge-approval.ts`, SCHEMA.md §6e),
// never the `code_review`. Reading a review's `created_by_type` would
// conflate who WROTE a review with who AUTHORISED a merge, leaving the clause
// satisfiable only by an act this guard's own message calls dishonest — which
// is a hold that does not hold.
import { guardOk, guardRejected, type Guard, type GuardInput } from "../state-machine/guard";
import {
  currentTipCommitSha,
  hasApproval,
  latestApprovalAtTip,
  tipCommitLineage,
} from "./artifact-tip";
import { historicalVerificationSatisfies } from "./historical-verification";
import { MERGE_APPROVAL_KIND, personHasApprovedMerge } from "./merge-approval";
import { MERGE_OVERRIDE_KIND, MIN_REASON_LENGTH, mergeOverrideSatisfies } from "./merge-override";
import {
  BLOCKING_SEVERITY_FLOOR,
  SEVERITY_GATED_VERDICT,
  blockingFindings,
  describeBlockingFindings,
} from "./merge-findings";
import { approvingArtifactAtCurrentRoundAndTip, currentReviewRound } from "./merge-review-round";
import { APPROVING_VERDICTS, requiresLinkedFollowUp } from "../../verdicts";

const MERGE_AUTHORITIES = new Set(["pre_approved", "needs_approval", "agent_judgement"]);

/**
 * The sentence every code-review refusal ends with, naming the override and
 * what it costs.
 *
 * **Stated in the refusal on purpose.** An earlier wording of this message
 * named a remedy — "proceed with a written reason" — that no surface
 * actually implemented, and a caller burned six attempts across three
 * hypotheses chasing it. An unreachable remedy is worse than none, because
 * it reads as actionable. This one names an operation that exists, the exact artifact
 * kind, and the two things that make it not-free: the reason is mandatory,
 * and the row is permanent and countable.
 *
 * One constant rather than the same prose in two places, so the two refusals
 * cannot drift into describing the escape hatch differently.
 */
const OVERRIDE_REMEDY =
  `If the review genuinely still applies and you are judging that nothing material changed, ` +
  `record a ${MERGE_OVERRIDE_KIND} artifact naming this commit, with a body of at least ` +
  `${MIN_REASON_LENGTH} characters saying why — it is kept permanently as an override rather ` +
  `than as a review, and overrides are counted.`;

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
    // ── The historical-verification alternative ───────────────────────────
    //
    // Checked FIRST and inside this clause, not as a sixth guard, for a
    // structural reason: guards are AND-composed and the first rejection
    // wins (`state-machine/guard.ts`), so a new guard could only ever ADD a
    // requirement — it could never satisfy the one this clause enforces.
    // An alternative satisfier has to live where the requirement lives.
    //
    // It answers a different question from the one below it. This clause
    // normally asks "did a reviewer approve the change before it shipped",
    // which for work that shipped before this installation existed has no
    // truthful answer. `historicalVerificationSatisfies` asks the question
    // that does: "has someone inspected the merged code and recorded what
    // they found". Both are evidence; they are not the same evidence, and
    // the point of keeping them separate kinds is that no reader can later
    // mistake one for the other. See `./historical-verification.ts`.
    const historical = await historicalVerificationSatisfies(input.db, input.item.id);
    if (historical.satisfied) {
      return guardOk;
    }
    // A verification exists and would otherwise have satisfied this clause,
    // but the item carries an `lgtm_with_followups` whose bargain is not
    // honoured. Refused HERE rather than left to
    // `merge.requires_linked_followup`, because that guard resolves its
    // approval by round and tip and so cannot see a bargain that has fallen
    // out of qualification — which is precisely the case an inspection at a
    // higher round creates. Named explicitly so the caller is not told to go
    // and get a code review when the actual obstacle is a dead follow-up.
    if (historical.blockedByFollowUp) {
      return guardRejected(
        "This item has a code review that merged on the promise its findings would be done " +
          `separately, but ${historical.blockedByFollowUp}. A historical_verification records ` +
          "that shipped code was inspected; it does not discharge a promise a review already " +
          "made. Link a follow-up item that is still open, or re-review at a verdict matching " +
          "what was actually found.",
        { fields: ["state"] },
      );
    }

    // ── The stated-reason override ────────────────────────────────────────
    //
    // Checked here, in the same clause and for the same structural reason as
    // the historical-verification alternative above: guards are AND-composed
    // and the first rejection wins, so an alternative satisfier has to live
    // where the requirement lives.
    //
    // Unlike that one this has no environment window, and the difference is
    // deliberate — see `./merge-override.ts`. It is always available, and
    // what makes that safe is that every use is a durable, attributed,
    // reasoned row rather than a request field that evaporates.
    const override = await mergeOverrideSatisfies(input.db, input.item.id);
    if (override.satisfied) {
      return guardOk;
    }

    const approvedAtAll = await hasApproval(input.db, input.item.id, "code_review");
    if (!approvedAtAll) {
      // When the window is open, a caller who has just been refused for
      // want of a review is exactly the caller who needs to know the other
      // path exists — and, more importantly, what it costs. Saying nothing
      // here is what makes forging a `code_review` the discoverable option.
      return guardRejected(
        "No approved code_review artifact for this item — get the code reviewed and approved before merging." +
          (historical.offerAlternative
            ? " If this item's work shipped before this installation existed and there is no " +
              "reviewer who could honestly have approved it, record a historical_verification " +
              "artifact instead: it must name the commit it was checked against and say what " +
              "was inspected, and it is recorded permanently as an inspection rather than as a " +
              "review."
            : "") +
          ` ${OVERRIDE_REMEDY}`,
        { fields: ["state"] },
      );
    }
    const resolvedApproval = await approvingArtifactAtCurrentRoundAndTip(
      input.db,
      input.item.id,
      "code_review",
    );
    const atCurrentRoundAndTip = resolvedApproval !== null;
    if (!atCurrentRoundAndTip) {
      const round = await currentReviewRound(input.db, input.item.id);
      const tip = await currentTipCommitSha(input.db, input.item.id);
      return guardRejected(
        `The most recent code_review approval is not for the current review round (${round}) ` +
          `and tip commit (${tip ?? "none"}). The item has moved since it was approved — get it ` +
          "re-reviewed." +
          // Named here specifically, because this is the refusal that used to
          // be unsatisfiable and the two remedies are for different causes.
          // If the sha moved because the forge rewrote the commit — a squash
          // merge, a rebase — that is not staleness and there is nothing to
          // re-review: record the landed commit with `supersedesSha` set to
          // the sha that WAS reviewed, and the existing approval carries
          // forward on its own. The override below is for the other case,
          // where something really did change and a human judges it
          // immaterial.
          " If the sha moved only because the commit was rewritten (a squash merge, a rebase, an" +
          " amend), that is not staleness: record the landed commit artifact with `supersedesSha`" +
          " set to the reviewed sha, and this approval carries forward without a new review." +
          ` ${OVERRIDE_REMEDY}`,
        { fields: ["state"] },
      );
    }

    // ── The severity clause ───────────────────────────────────────────────
    //
    // Graded against `resolvedApproval` — the very artifact the three checks
    // above came to rest on — and not against a separately-queried "latest
    // review". That is the whole point of resolving the row once: a second
    // query could grade a different artifact from the one being relied on,
    // which is the composition bug regressions (1) and (2) in this file's
    // header both were.
    //
    // **Placed last, after the override and the historical alternative have
    // already returned, and that ordering is deliberate.** Both of those are
    // alternatives to *having a review at all*; when either satisfies, there
    // is no resolved approving review whose findings could be graded, so
    // there is nothing here to say. It also means neither can be used to
    // launder a blocking finding: they return early precisely when no
    // approval is being relied on, whereas this clause only ever fires when
    // one IS. An override recorded on an item that also carries a
    // `lgtm_with_nits` with a MEDIUM does skip this check — correctly and by
    // construction, because that is a named human judgement, permanently
    // recorded and countable, that the remaining findings do not block. That
    // is the same thing the hatch already does for a missing review, and
    // `needs_approval` remains unaffected by it either way.
    const blocking = blockingFindings(resolvedApproval.verdict, resolvedApproval.findings);
    if (blocking.length > 0) {
      return guardRejected(
        `The approving code_review is ${SEVERITY_GATED_VERDICT}, which claims only nits remain, ` +
          `but it records ${blocking.length} finding${blocking.length === 1 ? "" : "s"} graded ` +
          `${BLOCKING_SEVERITY_FLOOR} or above:
${describeBlockingFindings(blocking)}
` +
          `A ${BLOCKING_SEVERITY_FLOOR}-or-worse finding under ${SEVERITY_GATED_VERDICT} blocks ` +
          "exactly as changes_required does — the verdict says the remainder is cosmetic and the " +
          "findings say otherwise. Either fix them and get a re-review at the new commit, or, if " +
          "they genuinely do not block this change, re-review recording the verdict that matches " +
          "what was found: lgtm if they are not real, or lgtm_with_followups with a linked " +
          "follow-up item if they are real but belong in separate work. Do not simply re-grade " +
          "the findings downward to clear this.",
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
 *     it is satisfied by a **`merge_approval` artifact recorded by a
 *     person** at the item's tip commit — SCHEMA.md §6e,
 *     `./merge-approval.ts`.
 *
 *     **It deliberately does not read the `code_review` artifact**, however
 *     it was recorded. `created_by_type` records who *wrote* an artifact, not
 *     who *permitted* a merge, so satisfying a hold that way means recording
 *     a review as a person — which this guard's own refusal message tells
 *     callers, in terms, not to do. A requirement whose only satisfier is an
 *     act the system calls dishonest is a dead end, and its effect is a hold
 *     that does not hold: an item held for a person's decision on a
 *     customer-facing change can land minutes later with the decision never
 *     made. Reading a separate kind also makes the ordinary case expressible
 *     — a person authorising work an agent reviewed, without either claiming
 *     the other's act.
 *
 *     The composition bugs the review clauses guard against do not arise
 *     here: they concern a person's *review* being resolved to a different
 *     artifact from the one the code-review clause relies on, and these two
 *     clauses share no artifact to disagree about. The tip scope is kept for
 *     its own reason — a decision is about a specific state of the code —
 *     and a round scope is deliberately not applied, since a reviewer opening
 *     a new round should not expire a human's decision at the same commit.
 *     See `./merge-approval.ts`.
 *
 *     **The refusal still names the standing-authorisation route.** A person
 *     saying "merge this class of work without asking me each time" is
 *     expressed by setting the item's `merge_authority` to `pre_approved`,
 *     not by anything in the transition request. A caller who holds one
 *     otherwise reads this refusal as "go and fetch a human" and stalls on
 *     work that was already authorised. Worth stating because the default
 *     cuts against it: an item minted by an agent lands on `needs_approval`,
 *     so the rows most likely to be covered by a standing grant are exactly
 *     the ones that do not announce it. It also still warns off the
 *     tempting-but-wrong route of recording the review as a person, which no
 *     longer satisfies this clause at all.
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
      const approval = await personHasApprovedMerge(input.db, input.item.id);
      if (!approval.satisfied) {
        const tip = await currentTipCommitSha(input.db, input.item.id);
        return guardRejected(
          "merge_authority is needs_approval — this item is held for a person's decision, and " +
            "no agent can supply it. " +
            (approval.staleApprovalExists
              ? "A person did approve this item, but at a commit it has since moved past" +
                (tip ? ` (current tip ${tip})` : "") +
                ". The work changed after the decision was made, so the decision does not " +
                "carry over: go back to them with what changed and record a fresh " +
                `${MERGE_APPROVAL_KIND} naming the current commit.`
              : `A person must record a ${MERGE_APPROVAL_KIND} artifact naming the commit to be ` +
                `merged${tip ? ` (tip is ${tip})` : ""} before this item can merge.`) +
            " This is a decision, not a review: a person approving work an agent reviewed is the " +
            "ordinary case, and it does not require them to have performed the review. Do NOT " +
            "record the code_review as a person instead — created_by_type says who WROTE the " +
            "artifact, so that credits a human with a review an agent performed and is not an " +
            "authorisation at all. A merge_override does not satisfy this clause either; it " +
            "widens what counts as review evidence, never who may authorise. If a person has " +
            "already authorised this class of work in advance, that is a standing grant and " +
            // The hyphenated spelling deliberately: that is what `update_item`
            // accepts (`pre_approved` is the DB enum, not the API value), and
            // a remedy naming a value the operation refuses is the
            // unreachable-remedy failure #243 fixed elsewhere in this file.
            'belongs on the item: set mergeAuthority to "pre-approved" with update_item.',
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

/**
 * The states in which a follow-up item is **not** a real commitment to do the
 * work: it is finished one way or another, or explicitly abandoned. Linking
 * one of these would satisfy the letter of `lgtm_with_followups` while
 * defeating the whole point — the deferred findings would be attached to
 * something nobody is ever going to pick up.
 *
 * `merged` and `research_done` are included alongside `wont_do` and
 * `cancelled` for the same reason even though they are successes: work that
 * has already shipped cannot absorb findings raised after it shipped.
 */
const CLOSED_ITEM_STATES: ReadonlySet<string> = new Set([
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
]);

interface FollowUpItemRow {
  id: string;
  state: string;
}

/**
 * Requires a linked follow-up item when — and only when — the approval this
 * merge is resting on carries the `lgtm_with_followups` verdict (SCHEMA.md
 * §6a).
 *
 * **What the verdict buys, and what it has to cost.** `lgtm_with_followups`
 * exists so that a finding which is real but not blocking *this* change does
 * not cost a whole extra review round: the change merges as it stands, and
 * the finding is done separately. That bargain is only honest if
 * "separately" is a thing that exists. Left to whoever remembers, this
 * becomes the verdict everyone reaches for to skip a round — it is strictly
 * cheaper than every alternative and nothing checks the other half — and the
 * follow-ups quietly never happen. The system would then have a verdict whose
 * observable effect is "merge without finishing the review", which is exactly
 * what tiering was meant to prevent.
 *
 * **Enforced at the merge, not at the write.** Recording the verdict is a
 * reviewer stating an opinion, and blocking that would mean a reviewer cannot
 * say what they found until someone has filed the follow-up. Spending it is
 * the irreversible step, so that is where the follow-up has to be real. This
 * also keeps the rule enforceable against history: an imported artifact can
 * carry the verdict without a link, and it simply cannot be used to merge
 * until one is attached.
 *
 * **Three distinct rejections, not one.** Missing link, dangling link, and
 * link-to-something-already-closed are different mistakes with different
 * fixes, and a guard that answered all three with one message would make the
 * caller guess which.
 *
 * **Why this guard is not the whole of the `lgtm_with_followups`
 * obligation.** This guard resolves the approval it reasons about through
 * `approvingArtifactAtCurrentRoundAndTip`, which qualifies on **round and
 * tip**. "No qualifying approval" is therefore not the same claim as "no
 * approval": an honest `lgtm_with_followups` stops qualifying the moment
 * either axis moves, and this guard then correctly says nothing, because the
 * artifact it would reason about is not the one the merge is resting on.
 *
 * What made that safe was that the same non-qualification also refused the
 * merge outright at `merge.requires_approving_code_review` — so an
 * unqualified bargain could never actually reach a merge. An alternative
 * satisfier for that clause removes the backstop, and `currentReviewRound`
 * being `MAX(review_round)` across *every* artifact kind means a verification
 * recorded at a higher round demotes the review by itself. So the
 * verification path re-checks the obligation at its own source
 * (`historical-verification.ts`'s `unhonouredFollowUpBargain`) rather than
 * assuming this guard covers it. Kept there and not widened here on purpose:
 * this guard's contract is "the approval the merge rests on", and broadening
 * it to any approval ever recorded would change what it means for the
 * ordinary review path too.
 */
export const mergeRequiresLinkedFollowUpGuard: Guard = {
  id: "merge.requires_linked_followup",
  description:
    "Entering merged on an lgtm_with_followups approval requires that approval to link a live follow-up item.",
  appliesTo: (_from, to) => to === "merged",
  async check(input: GuardInput) {
    // Deliberately the SAME artifact `merge.requires_approving_code_review`
    // accepts — resolved by the shared helper rather than re-queried here —
    // so this guard can never be reasoning about a different artifact from
    // the one the merge is actually resting on. If no approval qualifies,
    // this guard has nothing to say: that item is already refused by
    // `merge.requires_approving_code_review`, and a second rejection naming
    // the same cause would only obscure it.
    const approval = await approvingArtifactAtCurrentRoundAndTip(
      input.db,
      input.item.id,
      "code_review",
    );
    if (!approval || !requiresLinkedFollowUp(approval.verdict)) {
      return guardOk;
    }

    if (!approval.followUpItemId) {
      return guardRejected(
        "The approving code_review is lgtm_with_followups, which merges without a further " +
          "review round only because its findings are recorded as separate work — but no " +
          "follow-up item is linked to it. Create the follow-up and link it, or re-review at " +
          "a verdict that matches what was actually found.",
        { fields: ["state"] },
      );
    }

    const rows = await input.db.$queryRawUnsafe<FollowUpItemRow[]>(
      `SELECT "id", "state" FROM "Item" WHERE "id" = $1`,
      approval.followUpItemId,
    );
    const followUp = rows[0];
    if (!followUp) {
      // Reachable despite the foreign key: `Artifact.followUpItemId` is
      // `ON DELETE SET NULL`, so a deleted item nulls the link rather than
      // leaving it dangling — but a row read in one transaction can still
      // race a delete in another, and a guard that assumed the FK made this
      // impossible would throw on `undefined` instead of refusing.
      return guardRejected(
        `The approving code_review links follow-up item ${approval.followUpItemId}, which no ` +
          "longer exists. Link a follow-up item that does.",
        { fields: ["state"] },
      );
    }
    if (CLOSED_ITEM_STATES.has(followUp.state)) {
      return guardRejected(
        `The approving code_review links follow-up item ${followUp.id}, which is already ` +
          `${followUp.state} — a closed item cannot carry findings raised after it closed. ` +
          "Link a follow-up that is still open.",
        { fields: ["state"] },
      );
    }
    return guardOk;
  },
};

/** All five merge guards, for the registration module to install in one call. */
export const MERGE_GUARDS: readonly Guard[] = [
  mergeRequiresCommitGuard,
  mergeRequiresApprovingCodeReviewGuard,
  mergeRequiresVisualReviewGuard,
  mergeRequiresAuthorisationGuard,
  mergeRequiresLinkedFollowUpGuard,
];
