// Whether a `historical_verification` artifact may stand in for the
// approving `code_review` the merge gate normally requires — SCHEMA.md §6b,
// §16; MILESTONES.md #138.
//
// ── The problem, stated as the failure mode rather than as an inconvenience
//
// Entering `merged` requires an approving `code_review` at the item's current
// review round and tip commit. That is the right rule for a change being
// proposed: it is the only thing standing between unreviewed code and a board
// that says the code was reviewed. It has no truthful answer for work that
// **already shipped, before this installation existed**. There is no reviewer
// who could have written that artifact, because there was nothing to review
// it in.
//
// The consequence is not merely that a board stays wrong. An agent facing
// that refusal can record a `code_review` with an approving verdict and close
// the item in one call, and **nothing in the product can distinguish that
// from a real review** — a forged review is byte-identical to an honest one,
// in kind, in verdict, and in every column a reader sees. So the guard's
// value ends up resting on an agent choosing not to do the cheap thing, and
// the pressure to do it is highest exactly where the approval would mean
// least. A design whose failure mode is a forged approval should not depend
// on good manners.
//
// ── Why this does not become a way to wave work through ──────────────────
//
// The obvious objection to any second merge path is that it is a second merge
// path. Four properties are what make this one narrower than the hole it
// closes, and they are worth stating as a set, because no one of them carries
// the argument alone.
//
// **1. It cannot be opened from inside.** The window is an environment
// variable checked fail-closed (`./historical-verification-enabled.ts`), so
// no caller over HTTP, MCP or the command line can turn it on for itself.
// While it is closed this path does not exist, and the guard behaves exactly
// as it does without it. This is the property that makes the rest safe to
// discuss: everything below concerns what an operator has deliberately
// opened.
//
// **2. It is not a review and can never be read as one.** This is the part
// that carries the weight, and it is worth being precise about the claim. It
// does NOT make forgery impossible — an agent that will fabricate a review
// will fabricate an inspection. What it buys is that the fabrication is
// *visible*. A forged `code_review` asserts "a reviewer approved this
// change", which is the same sentence an honest review asserts; there is
// nothing in the record to notice. A
// `historical_verification` asserts something weaker and different: "someone
// read the merged code and this is what they checked". An item closed this
// way is permanently marked as closed-on-inspection, in its own artifact
// list, in its closing summary's `final_state`, and in the `merge` event's
// payload. The cheap path leaves a trace, which is precisely what an
// approving verdict recorded on the review path does not.
//
// **3. The claim has to be checkable.** A verdict is a judgement and cannot
// be audited after the fact; an inspection is a set of facts and can be.
// `record_artifact` refuses a `historical_verification` that does not name
// the commit it was checked against and say what was inspected, so the row
// carries the evidence a later reader needs to confirm or refute it. A claim
// that can be checked is a claim someone can be wrong about in public, which
// is a materially different thing from an unfalsifiable approval.
//
// **4. It never satisfies a human-approval requirement.** `merge_authority`
// of `needs_approval` is enforced by a separate clause that reads
// `kind = 'code_review' AND created_by_type = 'person'` and is untouched by
// anything here. So on an item where a person's sign-off is required, this
// path changes nothing at all: the item still cannot merge without one. The
// window widens what counts as *review evidence*, never what counts as
// *authorisation*.
//
// **What is deliberately NOT relied on.** An earlier shape of this gated on
// the item having arrived through an import — on `originType`, or on a
// `legacy_id` in `customFields`. Both are caller-supplied through the
// ordinary create path, so gating on either would have rested the whole
// protection on a value the caller writes. `sourceRef` is genuinely
// unforgeable through the product's write surface, but keying to it would
// grant a permanent second merge path to a permanent class of rows, still
// standing a year later when one of those items has been reopened and worked
// on live. A window is bounded by construction and expires by being closed.
import type { TransactionHandle } from "../context";
import { currentTipCommitSha } from "./artifact-tip";
import { isHistoricalVerificationEnabled } from "./historical-verification-enabled";

/** The artifact kind that records work verified by inspection against already-merged code. */
export const HISTORICAL_VERIFICATION_KIND = "historical_verification";

interface HistoricalVerificationRow {
  id: string;
  commitSha: string | null;
  body: string | null;
}

/**
 * The answer the merge gate needs, plus the one thing it needs for its
 * rejection message.
 *
 * `offerAlternative` is not the same question as `satisfied` and is
 * deliberately returned separately: it says only that the window is open, so
 * a refusal can tell the caller this path exists. Folding the two together
 * would either advertise a path that is shut or hide one that is open.
 */
export interface HistoricalVerificationOutcome {
  /** Whether a qualifying artifact exists, so the code-review clause is met by this route. */
  readonly satisfied: boolean;
  /** Whether the window is open at all — what decides if a refusal should mention this path. */
  readonly offerAlternative: boolean;
}

/**
 * Whether a `historical_verification` artifact satisfies the approving
 * code-review clause for this item.
 *
 * **Scoped to the tip commit, exactly as the review path is.** The artifact
 * must name the item's current tip commit, so an inspection of one commit
 * cannot silently carry over to a later one. This matters more here than for
 * a review, not less: the whole claim is "I read the code that is actually
 * there", and an inspection of superseded code is a claim about something
 * nobody is shipping.
 *
 * **Not scoped to the review round, and that is a decision rather than an
 * oversight.** `currentReviewRound` is `max(review_round)` across every kind
 * for the item, so requiring a match would create a trap: recording anything
 * at a higher round would silently invalidate an inspection, and — worse in
 * the other direction — an inspection recorded at a high round would
 * invalidate an honest `code_review` on a *live* item. Round is a fact about
 * a review conversation, and an inspection of merged code is not part of one.
 * Anchoring to the commit alone is both the honest scope and the one that
 * cannot interfere with the review path.
 */
export async function historicalVerificationSatisfies(
  db: TransactionHandle,
  itemId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<HistoricalVerificationOutcome> {
  // Checked before the query, not after: while the window is closed this path
  // does not exist, and the guard must behave precisely as it does without it
  // — including doing no extra work and reaching no conclusion about rows a
  // separate window may have left in the table.
  if (!isHistoricalVerificationEnabled(env)) {
    return { satisfied: false, offerAlternative: false };
  }

  const tip = await currentTipCommitSha(db, itemId);
  // No commit artifact means no tip to have inspected. `merge.requires_commit`
  // already refuses this item on its own clause, and returning `false` here
  // leaves that rejection to say so rather than producing a second, vaguer
  // one about verification.
  if (tip === null) {
    return { satisfied: false, offerAlternative: true };
  }

  const rows = await db.$queryRawUnsafe<HistoricalVerificationRow[]>(
    // `$2::"ArtifactKind"` — Postgres infers an enum type for a literal but
    // not for a bind parameter; the same cast every query in this directory
    // uses for the reason `artifact-tip.ts` documents.
    //
    // `"body" IS NOT NULL` is belt-and-braces: `record_artifact` already
    // refuses to write one of these without a body, so a row failing this
    // predicate should not exist. It is asserted here anyway because this is
    // the clause that decides a merge, and a guard that trusted an upstream
    // validator would be one edit away from accepting an empty claim.
    `SELECT "id", "commitSha", "body"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind"
        AND "commitSha" = $3 AND "body" IS NOT NULL
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 1`,
    itemId,
    HISTORICAL_VERIFICATION_KIND,
    tip,
  );

  return { satisfied: rows.length > 0, offerAlternative: true };
}
