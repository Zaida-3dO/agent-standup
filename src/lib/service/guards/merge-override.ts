// Whether a recorded `merge_override` artifact stands in for the approving
// `code_review` the merge gate normally requires — SCHEMA.md §6c, §16;
// MILESTONES.md #236.
//
// ── What this is for, stated as the judgement call it serves ─────────────
//
// The gate requires an approving review at the item's current review round
// and tip commit. Two separate things went wrong with that in practice, and
// only one of them is a judgement call:
//
//   1. **Squash-merge made it unsatisfiable.** Not strict — unsatisfiable,
//      by construction, in either ordering. That is a bug in the check and
//      it is fixed as a bug, in `artifact-tip.ts`'s `tipCommitLineage`: an
//      approval at a sha the tip was declared a rewrite of now qualifies.
//      **No override is consumed for that case, deliberately.** An override
//      that everyone always uses is a broken guard with extra steps, and it
//      would have buried the real defect under a pile of "reasons" nobody
//      reads.
//
//   2. **A genuine judgement call remains**, and it is the one Ope actually
//      asked for: "nothing much has changed since review, so the review is
//      still valid". A doc tweak after approval, a rebase onto a moved base,
//      a lint fix. The reviewer's judgement genuinely still applies, no rule
//      can establish that it does, and a human can see it in a second. This
//      module is for that, and only that.
//
// Fixing (1) first is what keeps (2) narrow. An escape hatch reached daily
// stops being read; one reached rarely, with a reason someone will see, is
// a record rather than a ritual.
//
// ── Why this cannot become a silent bypass ──────────────────────────────
//
// Four properties, and no one of them carries the argument alone.
//
// **1. It is a row, not a request field.** The obvious cheap implementation
// is a `merge_override_reason` string passed alongside the transition, the
// way `merge_rationale` already is. That was rejected: `fields` on a
// transition is read by the guard that wants it and then **discarded** —
// nothing persists it, so the reason would exist only inside the refusal
// that did not happen. An override nobody can read afterwards is a silent
// bypass with a conscience. An artifact is durable, attributed, timestamped,
// carries `createdByType`, and shows up in the item's own detail view beside
// the reviews it stood in for.
//
// **2. The reason is mandatory and is checked for content, not presence.**
// `record_artifact` refuses a `merge_override` with no body, and refuses one
// whose body is too short to say anything (`MIN_REASON_LENGTH`). A required
// field satisfiable by `"x"` is an optional field with extra keystrokes.
// This does not make a lazy reason impossible — nothing can — but it does
// mean the laziest available path is to type something a reader will see.
//
// **3. It is scoped to the commit it was written for.** The override names
// the sha it excuses, and stops applying the moment the item moves past it.
// An override is a statement about one specific state of the code — "I
// looked at what changed since review and it was nothing" — and a standing
// one would be an item-level permission to skip review forever, which is a
// different and much worse thing than what was asked for.
//
// **4. It never satisfies the human-authorisation clause.** `merge_authority
// = needs_approval` is enforced separately, reading `kind = 'code_review'
// AND created_by_type = 'person'`, and nothing here touches it. On an item
// where a person's sign-off is required, an override changes nothing: the
// item still cannot merge without one. This widens what counts as *review
// evidence*, never what counts as *authorisation* — the same boundary
// `historical_verification` respects, for the same reason.
//
// ── Why there is no environment window ──────────────────────────────────
//
// `historical_verification` is gated behind `ENABLE_HISTORICAL_VERIFICATION`
// because it serves a one-off event — closing a backlog of work that shipped
// before this installation existed — and a permanent capability for an event
// is a permanent second merge path.
//
// This is the opposite shape: the judgement call it serves recurs, at low
// volume, forever. A window would be opened and then left open, which is
// strictly worse than no window — it would read as a control while being
// permanently disarmed. The control here is that every use is a countable
// row with a name on it, which is a real one precisely because it does not
// depend on anybody remembering to close anything.
import type { TransactionHandle } from "../context";
import { currentTipCommitSha, shaMatchesTipOrLineage, tipCommitLineage } from "./artifact-tip";

/** The artifact kind recording a reasoned decision to merge without a fresh review. */
export const MERGE_OVERRIDE_KIND = "merge_override";

/**
 * The shortest body that counts as a stated reason.
 *
 * A length floor is a crude proxy for "said something" and is not pretending
 * otherwise — it cannot tell a considered sentence from forty characters of
 * keyboard. What it does do is remove the one-character reason, which is the
 * form a mandatory field collapses into when nothing checks it. Set where a
 * real reason ("rebased onto main, no source changes since review") clears it
 * comfortably and a dismissal ("ok", "n/a", "fine") does not.
 */
export const MIN_REASON_LENGTH = 20;

interface MergeOverrideRow {
  id: string;
  commitSha: string | null;
  body: string | null;
  createdByType: string;
  createdById: string;
}

/** What the merge gate needs from an override, plus what its refusal needs to say. */
export interface MergeOverrideOutcome {
  /** Whether a qualifying override exists, so the code-review clause is met by this route. */
  readonly satisfied: boolean;
  /** The override being relied on, for the event payload that records the merge. */
  readonly override?: {
    readonly id: string;
    readonly reason: string;
    readonly createdByType: string;
    readonly createdById: string;
  };
}

/**
 * Whether a `merge_override` artifact satisfies the approving code-review
 * clause for this item.
 *
 * **Scoped to the tip commit and its lineage, exactly as the review path
 * is.** The override must name the item's current tip — or a sha the tip was
 * declared a rewrite of, so that an override written against a reviewed
 * branch tip survives the squash that lands it, for the same reason an
 * approval does. Anything looser would let "nothing much changed since
 * review" be written once and spent against code written afterwards, which
 * is the one reading of this feature that would genuinely be dangerous.
 *
 * **Not scoped to the review round**, matching `historical_verification` and
 * for the reason its doc gives: `currentReviewRound` is `MAX(review_round)`
 * across every kind, so requiring a match would mean recording anything at a
 * higher round silently invalidates an override, and an override recorded at
 * a high round would invalidate an honest `code_review` on a live item. The
 * commit is the honest anchor; round is a fact about a review conversation
 * that an override is not part of.
 */
export async function mergeOverrideSatisfies(
  db: TransactionHandle,
  itemId: string,
): Promise<MergeOverrideOutcome> {
  const tip = await currentTipCommitSha(db, itemId);
  // No commit artifact means no tip for an override to be about.
  // `merge.requires_commit` already refuses this item on its own clause, and
  // returning `false` here leaves that rejection to say so rather than
  // producing a second, vaguer one about overrides.
  if (tip === null) {
    return { satisfied: false };
  }

  const lineage = await tipCommitLineage(db, itemId);

  // Fetches every override for the item and filters in TS with
  // `shaMatchesTipOrLineage`, rather than pushing the sha comparison into
  // the query with `"commitSha" = ANY($3::text[])` as this used to. That
  // SQL form is exact-value membership — the same abbreviation blindness
  // `latestApprovalAtTip` had before it routed through `shaMatches` (row
  // `e09aa150`) — and prefix matching is not something `= ANY` can express
  // without a per-row `LIKE`/regex OR-chain. The set of overrides for one
  // item is small (this is a rarely-used escape hatch, not a hot path per
  // its own module doc), so fetching all of them and filtering here costs
  // nothing that matters and keeps one implementation of "is this sha at
  // the tip" rather than a second one reimplemented in SQL.
  const rows = await db.$queryRawUnsafe<MergeOverrideRow[]>(
    // `$2::"ArtifactKind"` — Postgres infers an enum type for a literal but
    // not for a bind parameter; the same cast every query in this directory
    // uses, for the reason `artifact-tip.ts` documents.
    //
    // `"body" IS NOT NULL` is belt-and-braces: `record_artifact` already
    // refuses to write one of these without a reason, so a row failing this
    // predicate should not exist. It is asserted anyway because this clause
    // decides a merge, and a guard that trusted an upstream validator would
    // be one edit away from accepting an empty excuse.
    //
    // `seq`, not `id`, breaks the `createdAt` tie: `id` is a random uuid
    // with no relationship to insertion order, so on a same-millisecond tie
    // `rows.find` below could return an older override ahead of a newer one
    // (see `currentTipCommitSha`'s doc on `artifact-tip.ts` for the full
    // reasoning, which applies here identically).
    `SELECT "id", "commitSha", "body", "createdByType", "createdById"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind" AND "body" IS NOT NULL
      ORDER BY "createdAt" DESC, "seq" DESC`,
    itemId,
    MERGE_OVERRIDE_KIND,
  );

  const row = rows.find((candidate) => shaMatchesTipOrLineage(candidate.commitSha, tip, lineage));
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
