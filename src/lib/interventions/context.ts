// Assembling what a predicate is handed — MILESTONES.md #128.
//
// `InterventionContext` is deliberately a plain value a predicate cannot
// fetch anything through (`./types.ts`). Somebody therefore has to go and
// get it, and this is that somebody: it sits on the service side of the
// boundary, holds the transaction handle, and produces the serialisable
// object the registry passes down.
//
// ── The cost problem, and how it is answered ───────────────────────────
//
// `hook_decision` is declared `kind: "read"` and, until this row, touched
// no table at all — its own header calls a decision made on every tool call
// "the highest-volume path in the system" and says it stays a dumb pipe.
// Consulting the registry threatens exactly that, because the correctness
// entries genuinely need item state, claim state and review artifacts. A
// predicate cannot go and get them, so the assembly would otherwise have to
// fetch them for every call — turning every `Read`, every `ls` and every
// `Edit` into three queries so that the one `git merge` in ten thousand
// calls can be checked.
//
// **So the query is gated on the call being able to need it.** `needs`
// below reads the command text — free, already in memory — and reports
// which *kinds* of state any entry could want for this specific call.
// Nothing needed, no query, and the operation is the dumb pipe it was: that
// is the overwhelmingly common path and it is unchanged in what it costs.
//
// **Why this is not the layering violation it resembles.** The gate decides
// nothing and knows nothing about what any predicate concludes. It is a
// conservative over-approximation: it asks "could a merge check possibly be
// relevant here", errs towards yes, and a wrong yes costs one wasted query
// while a wrong no costs a missed finding. The alternative — letting
// predicates declare their own data dependencies as a schema the assembler
// solves — is the right eventual shape, and is what `INTERVENTIONS.md`'s
// "an intervention declares the context it needs" is reaching for. It needs
// a dependency vocabulary that does not exist yet, and inventing one to
// serve four entries would be fitting a general mechanism to a sample of
// four.
//
// The honest statement of the trade is on the record: this couples the
// assembler to the *shapes* the catalogue cares about, and a new entry
// needing a new kind of state must add a case here. That is a real cost,
// paid deliberately, because the alternative cost — a per-call query budget
// on the highest-volume path in the system — is paid on every call forever
// rather than once per catalogue entry.

import type { TransactionHandle } from "@/lib/service/context";
import { currentTipCommitSha } from "@/lib/service/guards/artifact-tip";
import { hasApprovingArtifactAtCurrentRoundAndTip } from "@/lib/service/guards/merge-review-round";
import { isMergeAttempt } from "./commands";
import { isBroadGitAdd } from "./builtins";
import type { InterventionContext } from "./types";

/**
 * What the call might need looked up.
 *
 * A record rather than a boolean so that a command needing claim state does
 * not also pay for artifact state. Both are cheap individually; separating
 * them is what keeps them cheap as the catalogue grows.
 */
export interface ContextNeeds {
  /** Which item and claim this session holds — one query over `Assignment`. */
  readonly assignment: boolean;
  /** Whether an approving review sits at the item's tip — the merge gate's own primitives. */
  readonly approval: boolean;
}

const NOTHING: ContextNeeds = { assignment: false, approval: false };

/**
 * Decides what this call could possibly need, from the command text alone.
 *
 * Reads no state, so it cannot itself be the expensive thing. Errs towards
 * needing more: a false positive costs one query on a call that was going
 * to be allowed anyway, and a false negative silently disarms an entry,
 * which is the failure nobody notices.
 *
 * Note what is deliberately absent — a broad process kill (I12) needs no
 * state at all, because the entry blocks on the *shape* of the command and
 * settled explicitly against an ownership check
 * (`docs/plans/INTERVENTIONS.md` I12). So it appears in no branch here, and
 * that is the design rather than an omission.
 */
export function needs(command: string | undefined): ContextNeeds {
  if (command === undefined || command.trim() === "") return NOTHING;

  // A merge attempt is the only shape that needs to know whether an
  // approval sits at the tip, and it needs the assignment first in order to
  // know *which item's* tip to ask about.
  if (isMergeAttempt(command)) return { assignment: true, approval: true };

  // A broad `git add` needs to know whether the checkout is shared, which
  // is the claim's `worktree` — no artifact question is involved.
  if (isBroadGitAdd(command)) return { assignment: true, approval: false };

  return NOTHING;
}

/** The one row shape the claim lookup reads. */
interface AssignmentRow {
  itemId: string;
  worktree: string | null;
  state: string;
  defaultBranch: string | null;
}

/**
 * Builds the context for one hook event.
 *
 * Every field it cannot honestly answer is left **absent**, never
 * defaulted. That is the contract the predicates are written against: an
 * absent field means "not known", and `./builtins.ts` treats not-known as
 * no-finding rather than as licence to guess. A `false` written here where
 * the truth is unknown would silently convert such an entry from cautious
 * to confidently wrong — and for the blocking entries, that is the
 * difference between a guard and an obstacle.
 */
export async function assembleContext(options: {
  readonly db: TransactionHandle;
  readonly sessionId: string;
  readonly tool?: string;
  readonly command?: string;
}): Promise<InterventionContext> {
  const { db, sessionId, tool, command } = options;

  const base: InterventionContext = {
    sessionId,
    ...(tool === undefined ? {} : { tool }),
    ...(command === undefined ? {} : { command }),
  };

  const wanted = needs(command);
  if (!wanted.assignment) return base;

  // The session's live claim, and the item and repository behind it. One
  // query rather than three: an item's state and its repository's default
  // branch are both facts about the same claim, and asking for them
  // separately would let two of them describe different claims.
  const rows = await db.$queryRawUnsafe<AssignmentRow[]>(
    `SELECT a."itemId"        AS "itemId",
            a."worktree"      AS "worktree",
            i."state"::text   AS "state",
            r."defaultBranch" AS "defaultBranch"
       FROM "Assignment" a
       JOIN "Item" i ON i."id" = a."itemId"
       LEFT JOIN "Repo" r ON r."id" = i."repo"
      WHERE a."sessionId" = $1 AND a."releasedAt" IS NULL
      ORDER BY a."claimedAt" DESC
      LIMIT 1`,
    sessionId,
  );

  const claim = rows[0];
  // No live claim is a genuine and common state — an unclaimed session
  // running commands — and it is not an error. It leaves every item-shaped
  // field absent, which is exactly right: there is no item to say anything
  // about.
  if (claim === undefined) return base;

  const withClaim: InterventionContext = {
    ...base,
    itemId: claim.itemId,
    itemState: claim.state,
    // A claim records the worktree it was taken in. A non-empty value means
    // a linked worktree with its own index; `null` means the claim never
    // recorded one, which is **unknown**, not "the shared checkout" — so
    // the field stays absent rather than becoming `false`.
    ...(claim.worktree === null ? {} : { isLinkedWorktree: claim.worktree.trim() !== "" }),
  };

  if (!wanted.approval) return withClaim;

  // The merge gate's own primitives, reused rather than reimplemented. If
  // this asked the question differently from the guard that enforces it at
  // `transition_item`, the two would eventually disagree — and the version
  // that disagreed would be the one blocking a session's shell command with
  // no way to see why.
  const tip = await currentTipCommitSha(db, claim.itemId);
  const approved = await hasApprovingArtifactAtCurrentRoundAndTip(db, claim.itemId, "code_review");

  return {
    ...withClaim,
    // With no commit artifact at all there is no tip for an approval to be
    // at, so "is there an approval at tip" has no true answer and the field
    // stays absent. An item nobody has committed to is not an item somebody
    // is merging without review; it is one that has not got there yet.
    ...(tip === null ? {} : { hasApprovalAtTip: approved }),
    ...(claim.defaultBranch === null ? {} : { defaultBranch: claim.defaultBranch }),
  };
}
