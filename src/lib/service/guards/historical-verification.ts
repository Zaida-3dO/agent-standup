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
// list, in its closing summary's `final_state`, and by the absence of the
// `review` event a real review would have emitted. The cheap path leaves a
// trace, which is precisely what an
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
import { currentReviewRound } from "./merge-review-round";
import { isHistoricalVerificationEnabled } from "./historical-verification-enabled";
import { APPROVING_VERDICTS } from "../../verdicts";

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
  /**
   * Set when a qualifying verification exists but an unhonoured
   * `lgtm_with_followups` bargain blocks it — the phrase naming which
   * obligation, for the refusal message.
   */
  readonly blockedByFollowUp?: string;
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
      ORDER BY "createdAt" DESC, "seq" DESC
      LIMIT 1`,
    itemId,
    HISTORICAL_VERIFICATION_KIND,
    tip,
  );

  if (rows.length === 0) {
    return { satisfied: false, offerAlternative: true };
  }

  // An inspection may stand in for a review that was never possible. It must
  // never dissolve an obligation a review that DID happen created.
  //
  // `merge.requires_linked_followup` enforces the `lgtm_with_followups`
  // bargain — merge now, without a further round, because the findings are
  // recorded as separate live work. That guard resolves the approval it
  // reasons about through `approvingArtifactAtCurrentRoundAndTip`, which
  // qualifies on **round and tip**, so an honest `lgtm_with_followups` stops
  // qualifying the moment either moves. Absent this check that is a silent
  // bypass rather than a theoretical one: `currentReviewRound` is
  // `MAX(review_round)` across *every* artifact kind, so recording a
  // verification at a higher round demotes the review out of qualification by
  // itself — and `record_artifact` takes `reviewRound` from the caller. The
  // follow-up guard then finds no qualifying approval, correctly says nothing,
  // and the bargain evaporates.
  //
  // What made that safe before an alternative satisfier existed was that the
  // same non-qualification also refused the merge outright at
  // `merge.requires_approving_code_review`. Satisfying that clause by another
  // route removes the backstop, so the obligation has to be re-checked here
  // rather than assumed to be someone else's job.
  //
  // Scoped to the item rather than to a round or a tip: a bargain that fell
  // out of qualification is exactly the one at risk of being forgotten, so
  // asking only about the approval that qualifies would miss the case that
  // matters. Which review may RETIRE a bargain is a separate question,
  // and there the qualification bar does apply — see the function itself.
  const unhonoured = await unhonouredFollowUpBargain(db, itemId);
  if (unhonoured) {
    return { satisfied: false, offerAlternative: true, blockedByFollowUp: unhonoured };
  }

  return { satisfied: true, offerAlternative: true };
}

interface FollowUpBargainRow {
  verdict: string | null;
  followUpItemId: string | null;
  followUpState: string | null;
  /** True when the LEFT JOIN matched nothing — a link to an item that is gone. */
  followUpMissing: boolean;
  /** True when a strictly-newer approving review qualifying at the current round and tip retires this bargain. */
  superseded: boolean;
}

/**
 * The states in which a linked follow-up has stopped being live work — the same
 * set, and the same reasoning, `merge.requires_linked_followup` applies
 * (`./merge.ts`'s `CLOSED_ITEM_STATES`). Work that has already stopped cannot
 * absorb findings raised before it stopped.
 */
const CLOSED_FOLLOW_UP_STATES: ReadonlySet<string> = new Set([
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
]);

/**
 * A description of an **unhonoured** `lgtm_with_followups` bargain on this
 * item — one whose findings were never given a live home — or `null` when
 * every bargain the item carries is honoured or superseded.
 *
 * **An EXISTS over every bargain, not a property of the newest approval.**
 * The obvious shape — take the newest approving review and ask whether it
 * requires a follow-up — is wrong, and wrong in a way that is reachable with
 * one extra ordinary call. `record_artifact` does not check a `code_review`'s
 * `commitSha` against the tip, so a caller can record a *deliberately stale*
 * plain `lgtm`: too stale to satisfy any merge clause itself, but newest by
 * `createdAt`, so it wins a `LIMIT 1` and answers "no follow-up required" on
 * behalf of an unhonoured bargain sitting one row below. The obligation would
 * be discharged by a review that never reviewed the code being merged.
 *
 * So the question this asks is the one the guard actually needs — *does an
 * unhonoured bargain exist anywhere on this item* — and supersession is
 * granted only to a review that could itself carry the merge: strictly newer,
 * approving, and **qualifying at the current round and tip**. That is the
 * same bar `merge.requires_linked_followup` applies to the approval it rests
 * on, which is the point: an obligation may only be retired by a review with
 * standing to retire it. A stale row has no standing.
 *
 * Returns a sentence rather than a boolean because the caller turns it into a
 * refusal, and a refusal that cannot say which obligation it is enforcing
 * sends the reader hunting through an artifact list.
 */
async function unhonouredFollowUpBargain(
  db: TransactionHandle,
  itemId: string,
): Promise<string | null> {
  const round = await currentReviewRound(db, itemId);
  const tip = await currentTipCommitSha(db, itemId);

  const rows = await db.$queryRawUnsafe<FollowUpBargainRow[]>(
    // Every `lgtm_with_followups` on the item, oldest first, each carrying
    // whether a strictly-newer *qualifying* approval supersedes it.
    //
    // `i."id" IS NULL` distinguishes "the join found no row" from "the row's
    // state is null" — the same test `merge.ts` makes for a dangling link,
    // rather than inferring absence from a null column value.
    //
    // The supersession subquery mirrors `approvingArtifactAtCurrentRoundAndTip`:
    // approving verdict, at the item's current review round, naming the
    // current tip commit. `IS NOT DISTINCT FROM` for the sha so that an item
    // with no commit artifact at all (tip null) compares as equal to a null
    // `commitSha`, which is the reading the tip helpers already document.
    //
    // `(s."createdAt", s."seq") > (a."createdAt", a."seq")` — a strict
    // tuple comparison deciding whether a review genuinely retires the
    // bargain, not a cosmetic ordering: comparing by `id` on a
    // same-millisecond tie makes `superseded` a coin flip on two random
    // uuids, because a random v4 carries no relationship to insertion
    // order — a merge could legally proceed or be refused depending on
    // which uuid happened to sort higher, for artifacts written in the same
    // transaction-timing window a concurrent write can produce. `seq` is
    // Postgres-assigned true insertion order (see its own doc on the Prisma
    // model), so the strictly *later* review is the one that wins, which is
    // what "supersedes" is supposed to mean.
    `SELECT a."verdict"::text AS "verdict",
            a."followUpItemId",
            i."state"::text AS "followUpState",
            (i."id" IS NULL) AS "followUpMissing",
            EXISTS (
              SELECT 1 FROM "Artifact" s
               WHERE s."itemId" = a."itemId"
                 AND s."kind" = 'code_review'::"ArtifactKind"
                 AND s."verdict" = ANY($2::"Verdict"[])
                 AND s."reviewRound" = $3
                 AND s."commitSha" IS NOT DISTINCT FROM $4
                 AND (s."createdAt", s."seq") > (a."createdAt", a."seq")
            ) AS "superseded"
       FROM "Artifact" a
       LEFT JOIN "Item" i ON i."id" = a."followUpItemId"
      WHERE a."itemId" = $1 AND a."kind" = 'code_review'::"ArtifactKind"
        AND a."verdict" = 'lgtm_with_followups'::"Verdict"
      ORDER BY a."createdAt" ASC, a."seq" ASC`,
    itemId,
    APPROVING_VERDICTS,
    round,
    tip,
  );

  for (const bargain of rows) {
    if (bargain.superseded) continue;
    if (!bargain.followUpItemId) {
      return "it links no follow-up item";
    }
    if (bargain.followUpMissing) {
      return `its follow-up item ${bargain.followUpItemId} does not exist`;
    }
    if (bargain.followUpState !== null && CLOSED_FOLLOW_UP_STATES.has(bargain.followUpState)) {
      return `its follow-up item ${bargain.followUpItemId} is already ${bargain.followUpState}`;
    }
  }

  return null;
}
