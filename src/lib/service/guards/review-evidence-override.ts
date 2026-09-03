// Whether a recorded `review_evidence_override` artifact stands in for
// review evidence a guard would otherwise require — SCHEMA.md §6c;
// MILESTONES.md #236.
//
// ── The ask this answers, in the words it was asked in ──────────────────
//
// Ope, 2026-09-02: *"the whole review is not at tip thing has been more
// disruptive than helpful — allow the orchestrator manually say 'it's okay
// nothing much has changed since review so the review is still valid', maybe
// make it be a nudge or a block overridable with reason?"* And, of the
// review-artifact requirement itself: *"especially when backfilling it's
// just a bunch of tokens wasted."*
//
// Both are the same shape: a requirement that is right by default and wrong
// often enough to be worth a stated exception. The evidence is not
// anecdotal. Closing five already-merged rows in one session required five
// `merge_override` artifacts in twenty minutes, because the gate demanded a
// fresh review of code that had shipped days earlier. **A guard correctly
// overridden five times running is telling you its default is wrong.**
//
// ── Why this generalises `merge_override` rather than copying it ────────
//
// `./merge-override.ts` already solved this problem for exactly one clause:
// `merge.requires_approving_code_review`. Its reasoning — a durable
// attributed row rather than a request field, a mandatory reason checked for
// content, scoped to the commit it was written for, and structurally unable
// to satisfy human authorisation — is correct and is not restated here
// because it is not being changed. What was wrong was its *reach*.
//
// `artifact.evidence_at_tip` refuses `plan_review → executing` when the
// approved plan does not sit at the item's tip commit, and it is the guard
// Ope named first. Without an override that block is absolute: a caller
// hitting it has two options, get a plan re-reviewed that nobody believes has
// changed, or abandon the transition.
//
// So the escape hatch is not being invented here. It is being pointed at the
// second clause that needed it, with one deliberate widening described
// below.
//
// ── The one widening: an override may be anchored to "no commit" ────────
//
// `merge_override` requires a `commitSha`, and for the merge gate that is
// right: `merge.requires_commit` independently guarantees a tip exists, so
// an override with nothing to name would be an override about nothing.
//
// The plan-tip clause has no such guarantee, and it can refuse an item that
// has **no tip at all**. That case is worth stating precisely, because the
// obvious reading of it is wrong and was wrong in an earlier draft of this
// comment.
//
// `shaMatchesTipOrLineage` treats a null tip as matching a null candidate:
// an approval that records no commit, on an item that records no commit, is
// NOT stale — there is nothing for it to be stale against. So the refusal at
// a null tip is not "the approval recorded no commit". It is the reverse and
// less obvious case: **the approval records a sha and the item records no
// commit artifact** (or its newest `commit` row carries a null sha). Every
// approving row then fails to match, `latestApprovalAtTip` returns null, and
// the guard refuses — while `currentTipCommitSha` has nothing to name, so
// the refusal falls into its "does not record which commit it applies to"
// branch and describes the situation somewhat backwards.
//
// This was verified against a real database rather than reasoned about,
// after the reasoning got it the wrong way round once. It is reachable, it
// is exactly the backfill shape (an approval pinned to a sha on a row whose
// commit artifacts were never recorded), and there is no sha an override
// could name to escape it: the item has no tip. Requiring one would leave
// this refusal with a remedy nobody can take, which is the unreachable-remedy
// failure this repository has already paid for twice.
//
// The widening is therefore: when the item has a tip, an override MUST name
// it (or its lineage) exactly as `merge_override` does; when the item has no
// tip at all, an override with no `commitSha` applies. It is not a loophole,
// because the condition is a property of the item rather than of the
// override: a caller cannot elect to have no tip, and the moment a commit
// artifact exists the strict scoping is back. An override written while
// there was no tip stops applying as soon as there is one.
//
// ── What it deliberately cannot do ─────────────────────────────────────
//
// **It never satisfies `merge.requires_authorisation`.** That clause reads
// `kind = 'code_review' AND created_by_type = 'person'` and nothing here
// touches it. The distinction it draws is the load-bearing one in this whole
// area: an override widens what counts as *review evidence*, never *who may
// authorise a merge*. An agent may not supply a person's decision, and no
// property of a well-written override changes that. `merge-guards.test.ts`
// pins this for `merge_override`; `review-evidence-override.test.ts` pins it
// for this kind too, because a boundary that is only intended is a boundary
// one edit from being gone.
//
// **It is not a settings toggle.** The obvious cheap reading of "make it
// overridable" is a flag that turns the guard off. That was rejected: a flag
// gets set once and left, which is a permanent global disarm that still
// reads as a control. The whole value here is that every use is a countable
// row with a name and a reason on it, which is only true if using it stays a
// per-occasion act.
import type { TransactionHandle } from "../context";
import { currentTipCommitSha, shaMatchesTipOrLineage, tipCommitLineage } from "./artifact-tip";

/**
 * The artifact kind recording a reasoned decision that existing review
 * evidence still stands, where a guard would otherwise require fresh
 * evidence.
 *
 * Its own kind rather than a reuse of `merge_override`, for the reason that
 * kind is its own rather than a flag on `code_review`: the claim being made
 * is different. `merge_override` says "merge this without the approving
 * review the gate wants". This says "the review you have is still the right
 * evidence". Reading a count of one as if it were the other would misstate
 * how often this installation bypasses its merge gate, which is precisely
 * the number the kind exists to make countable.
 */
export const REVIEW_EVIDENCE_OVERRIDE_KIND = "review_evidence_override";

/**
 * The shortest body that counts as a stated reason.
 *
 * Deliberately the same twenty characters as `merge_override`'s
 * `MIN_REASON_LENGTH` and the hook side's `MIN_OVERRIDE_REASON_LENGTH`. The
 * same judgement is being made about the same kind of statement, and a third
 * floor would mean an override accepted by one surface and refused by
 * another — the "do the right thing and still be refused" split this system
 * has already had one of.
 *
 * A length floor is a crude proxy and does not pretend otherwise: it cannot
 * tell a considered sentence from forty characters of keyboard. What it
 * removes is the one-character reason, which is the form a mandatory field
 * collapses into when nothing checks it.
 */
export const MIN_EVIDENCE_REASON_LENGTH = 20;

interface OverrideRow {
  id: string;
  commitSha: string | null;
  body: string | null;
  createdByType: string;
  createdById: string;
}

/** What a guard needs from an override, plus what its refusal needs to say. */
export interface ReviewEvidenceOverrideOutcome {
  /** Whether a qualifying override exists, so the clause is met by this route. */
  readonly satisfied: boolean;
  /** The override being relied on, for the event payload that records the move. */
  readonly override?: {
    readonly id: string;
    readonly reason: string;
    readonly createdByType: string;
    readonly createdById: string;
  };
}

/**
 * Whether a `review_evidence_override` artifact satisfies a review-evidence
 * clause for this item.
 *
 * **Scoped to the tip commit and its lineage when there is one**, exactly as
 * the review path is — including the lineage allowance, so an override
 * written against a reviewed branch tip survives the squash that lands it,
 * for the same reason an approval does. Anything looser would let "nothing
 * much changed since review" be written once and spent against code written
 * afterwards, which is the one reading of this feature that would genuinely
 * be dangerous.
 *
 * **When the item has no tip commit at all**, an override that names no sha
 * applies — see this module's header for why that case is real rather than a
 * hole, and why a caller cannot manufacture it. An override that *does* name
 * a sha never applies to a tipless item: it was written about a state of the
 * code this item has no record of, so honouring it would be honouring a
 * statement about something else.
 */
export async function reviewEvidenceOverrideSatisfies(
  db: TransactionHandle,
  itemId: string,
): Promise<ReviewEvidenceOverrideOutcome> {
  const tip = await currentTipCommitSha(db, itemId);
  // Empty SET, not an empty array: `shaMatchesTipOrLineage` takes a
  // `ReadonlySet`. The lineage is only consulted on the `tip !== null` branch
  // below, so its value here is unused rather than merely empty — but it is
  // typed correctly rather than cast, because a cast would hide the next
  // signature change instead of failing on it.
  const lineage =
    tip === null ? (new Set<string>() as ReadonlySet<string>) : await tipCommitLineage(db, itemId);

  // Fetches every override for the item and filters in TS with
  // `shaMatchesTipOrLineage`, rather than pushing the sha comparison into the
  // query. That SQL form is exact-value membership — the abbreviation
  // blindness `latestApprovalAtTip` had before it routed through `shaMatches`
  // — and prefix matching is not something `= ANY` can express without a
  // per-row `LIKE`/regex OR-chain. The set of overrides for one item is small
  // (this is a rarely-used escape hatch, not a hot path), so fetching all of
  // them and filtering here costs nothing that matters and keeps one
  // implementation of "is this sha at the tip".
  const rows = await db.$queryRawUnsafe<OverrideRow[]>(
    // `$2::"ArtifactKind"` — Postgres infers an enum type for a literal but
    // not for a bind parameter; the same cast every query in this directory
    // uses, for the reason `artifact-tip.ts` documents.
    //
    // `"body" IS NOT NULL` is belt-and-braces: `record_artifact` already
    // refuses to write one of these without a reason, so a row failing this
    // predicate should not exist. It is asserted anyway because this clause
    // decides a transition, and a guard that trusted an upstream validator
    // would be one edit away from accepting an empty excuse.
    //
    // `seq`, not `id`, breaks the `createdAt` tie: `id` is a random uuid with
    // no relationship to insertion order, so on a same-millisecond tie
    // `rows.find` below could return an older override ahead of a newer one.
    `SELECT "id", "commitSha", "body", "createdByType", "createdById"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind" AND "body" IS NOT NULL
      ORDER BY "createdAt" DESC, "seq" DESC`,
    itemId,
    REVIEW_EVIDENCE_OVERRIDE_KIND,
  );

  const row = rows.find((candidate) =>
    tip === null
      ? // No tip: only an override that names no sha is about this item's
        // current state. One naming a sha is a statement about a commit this
        // item does not record, and is not honoured.
        candidate.commitSha === null
      : shaMatchesTipOrLineage(candidate.commitSha, tip, lineage),
  );
  if (!row) {
    return { satisfied: false };
  }

  return {
    satisfied: true,
    override: {
      id: row.id,
      reason: row.body ?? "",
      createdByType: row.createdByType,
      createdById: row.createdById,
    },
  };
}

/**
 * The sentence a refusal ends with, naming the override and what it costs.
 *
 * **Stated in the refusal on purpose**, and this is the property the whole
 * feature rests on. An earlier wording elsewhere in this repository named a
 * remedy — "proceed with a written reason" — that no surface implemented,
 * and a caller burned six attempts across three hypotheses chasing it. An
 * unreachable remedy is worse than none, because it reads as actionable.
 *
 * `guardId` is named in the text because an override is scoped to the clause
 * it excuses, and because a reader counting overrides later needs to know
 * which guard's default was judged wrong — the signal the intervention
 * scoring work consumes. A count that cannot be attributed to a guard says
 * overriding happened without saying what should change.
 */
export function reviewEvidenceOverrideRemedy(guardId: string, hasTip: boolean): string {
  return (
    `If the existing review genuinely still applies and you are judging that nothing material ` +
    `changed, record a ${REVIEW_EVIDENCE_OVERRIDE_KIND} artifact ` +
    (hasTip
      ? "naming this commit"
      : "with no commitSha (this item records no commit for one to name)") +
    `, with a body of at least ${MIN_EVIDENCE_REASON_LENGTH} characters saying why. It is ` +
    `recorded permanently against "${guardId}" as an override rather than as a review, and ` +
    `overrides are counted — the reason is kept as a record, not checked for correctness.`
  );
}
