// Why a call that needs the caller's own live assignment could not find one.
//
// `checkpoint`, `release` and `heartbeat` all make the same lookup for the
// same reason — the write attributes to an assignment, so it needs the
// caller's. When that lookup comes back empty they all said the same thing:
// "session X does not hold a live assignment on Y". That sentence is
// accurate and it is not usable, because it is the answer to three
// different situations whose correct responses point in opposite
// directions:
//
//   1. **Never held one.** A dispatched subagent that was never assigned —
//      the common, documented case. It should use `note`, or `claim` first.
//   2. **Held one; it was released and nobody else has the item.** The
//      liveness ladder or a contention eviction reclaimed a quiet session.
//      Re-claiming is safe and is the intended recovery.
//   3. **Held one; another session holds the item now.** Re-claiming would
//      take an item out from under a session that may well be working on
//      it, so this is the one case the refusal has to warn against.
//
// A reporter who hit case 2 recovered by guessing, said so, and pointed out
// that the same guess in case 3 would have been the harmful move. That is
// the defect this module fixes: the response was fine as a fact and useless
// as a decision input.
//
// **Case 3 is keyed on who holds the item now, not on `supersededBy`.** The
// column exists on `Assignment` and so does the `superseded` liveness rung,
// but nothing in this codebase writes either one: both the contention
// eviction and the liveness sweep record a takeover as `releasedAt` plus
// `liveness = 'dead'`. Branching on `supersededBy` would read well and
// never fire. Present ownership is the fact that actually decides the
// reader's next move, and it stays correct if supersession is ever wired
// up, because a superseding holder is a live holder.

import type { TransactionHandle } from "../context";

/** The most recent assignment this session has held on the item, if any. */
export interface PriorAssignment {
  readonly releasedAt: Date | null;
  readonly liveness: string;
}

/** A session other than the caller that holds the item right now, if any. */
export interface CurrentHolder {
  readonly sessionId: string;
  readonly role: string | null;
}

export interface AssignmentRefusalInputs {
  readonly sessionId: string;
  readonly itemId: string;
  /** What the caller was trying to do — "a checkpoint", "a heartbeat". */
  readonly action: string;
  readonly prior: PriorAssignment | null;
  readonly currentHolder: CurrentHolder | null;
  /**
   * Why the missing assignment stops this particular call, as a clause
   * following "so {action} ".
   *
   * Parameterised because the shared default — "has nothing to attribute
   * to" — is only true of the callers that write something attributed to
   * the assignment. `heartbeat` deliberately appends no event at all; it
   * stamps a column on the assignment row. Telling its caller the write had
   * nothing to attribute to describes an operation it is not making, which
   * is the same class of confidently-wrong help this module exists to
   * remove — one layer further in.
   */
  readonly consequence?: string;
  /**
   * What to do with work in hand, when another session holds the item.
   *
   * Also parameterised, and for the sharper of the two reasons. "Use note to
   * record what you have" is good advice for a checkpoint, which is carrying
   * prose worth preserving. A `release` or a `heartbeat` is carrying
   * nothing: one is giving up ownership and the other is a liveness ping, so
   * directing either to write a note invents content it does not have and
   * costs the reader a call to find that out.
   */
  readonly takenOverAdvice?: string;
  /**
   * The alternative offered to a caller that never held the item, as a
   * clause following "claim it first" and before the closing full stop.
   *
   * `note` is the right redirect only for a caller carrying something to
   * record. For `release` there is a better answer than either claiming or
   * noting — a session that holds nothing has already achieved what a
   * release would have done — and saying so is what stops the reader
   * claiming an item purely in order to give it back.
   */
  readonly neverHeldAlternative?: string;
}

/** Which of the three situations the caller is in. */
export type AssignmentRefusalCase = "never_held" | "released_free" | "taken_over";

export interface AssignmentRefusal {
  readonly case: AssignmentRefusalCase;
  readonly message: string;
}

/**
 * Names which of the three cases the caller is in, and says what to do.
 *
 * Pure, and separated from the query for the reason `nextLivenessRung` and
 * `judgeEviction` are: the interesting part is the case split, and a case
 * split tested only through a database is tested by whatever rows the test
 * happened to seed.
 */
export function describeAssignmentRefusal(input: AssignmentRefusalInputs): AssignmentRefusal {
  const { sessionId, itemId, action, prior, currentHolder } = input;
  // The defaults describe a caller that writes something attributed to the
  // assignment, which is what `checkpoint` and `release` both do. An
  // operation for which either sentence is untrue passes its own.
  const consequence = input.consequence ?? "has nothing to attribute to";
  const takenOverAdvice =
    input.takenOverAdvice ??
    "Use note to record what you have, and check with whoever dispatched you.";
  const neverHeldAlternative =
    input.neverHeldAlternative ??
    "; if you are reporting alongside a session that holds it, use note instead — note needs no assignment";

  // Case 3 first: it is the only one where the obvious recovery is harmful,
  // so it must win any overlap with the others. A caller whose own claim was
  // released AND whose item now has another holder needs the warning, not
  // the invitation to re-claim.
  if (currentHolder) {
    const asRole = currentHolder.role ? ` as ${currentHolder.role}` : "";
    const heldBefore = prior
      ? `Session ${currentHolder.sessionId} holds ${itemId} now${asRole}, and your own assignment on it has been released.`
      : `Session ${sessionId} holds no assignment on ${itemId}, and session ${currentHolder.sessionId} holds it now${asRole}.`;
    return {
      case: "taken_over",
      message:
        `${heldBefore} Do NOT claim it to get ${action} through without checking first — ` +
        `another session is on this item and claiming would take it from them. ` +
        takenOverAdvice,
    };
  }

  if (prior) {
    return {
      case: "released_free",
      message:
        `Your assignment on ${itemId} was released, so ${action} ${consequence}. ` +
        `No other session holds this item, so claiming it again is safe and is the intended ` +
        `recovery — a claim that goes quiet for long enough is reclaimed, and a long silent ` +
        `stretch of work looks the same as a session that died. Claim it again and carry on.`,
    };
  }

  return {
    case: "never_held",
    message:
      `Session ${sessionId} has never held an assignment on ${itemId}, and ${action} ` +
      `${consequence}. If you were dispatched to work on this item, claim it first` +
      `${neverHeldAlternative}.`,
  };
}

/**
 * Reads the two facts the case split needs, and describes the refusal.
 *
 * Taken only on the failing path, by all three operations that make the
 * assignment lookup — so a call that succeeds costs exactly what it did
 * before, and the two extra reads are paid only by a caller who is about to
 * be refused and needs to know why.
 *
 * Here rather than in each operation for the reason `assignmentRequiredRule`
 * is: three copies of this pair of queries is three chances for a fix to
 * reach one copy and miss the others, and the resulting divergence is
 * invisible — every copy still refuses, just with a different amount of
 * help. That is the failure this module was written to end, so reproducing
 * it three times inside the fix would be an odd way to finish.
 */
export async function refuseForMissingAssignment(
  db: TransactionHandle,
  input: Omit<AssignmentRefusalInputs, "prior" | "currentHolder">,
): Promise<AssignmentRefusal> {
  const priorRows = await db.$queryRawUnsafe<PriorAssignment[]>(
    `SELECT "releasedAt", "liveness"::text AS "liveness" FROM "Assignment"
     WHERE "itemId" = $1 AND "sessionId" = $2
     ORDER BY "claimedAt" DESC
     LIMIT 1`,
    input.itemId,
    input.sessionId,
  );
  const holderRows = await db.$queryRawUnsafe<CurrentHolder[]>(
    `SELECT "sessionId", "role"::text AS "role" FROM "Assignment"
     WHERE "itemId" = $1 AND "sessionId" <> $2 AND "releasedAt" IS NULL
     ORDER BY "claimedAt" ASC
     LIMIT 1`,
    input.itemId,
    input.sessionId,
  );
  return describeAssignmentRefusal({
    ...input,
    prior: priorRows[0] ?? null,
    currentHolder: holderRows[0] ?? null,
  });
}

/**
 * The contract rule for the lookup above, stated as a caller must satisfy it.
 *
 * Declared here, beside the case split it describes, rather than three times
 * in the three operations that make this lookup — the same reasoning
 * `OperationRule` gives for declaring a rule at the site of its check. Three
 * copies of one sentence is three chances for a correction to reach one copy
 * and miss the other two, leaving the surface disagreeing with itself.
 *
 * **Why it exists at all**, which is the incident this function was written
 * for. `describe_tool` derives `rules` from the `contract` an operation
 * declares, and these three operations declared none — so the honest answer
 * "this operation states no rules" was returned in a shape indistinguishable
 * from "this operation has no preconditions", against operations whose
 * precondition is a database read that refuses callers daily. Three separate
 * documents were then "corrected" to say `checkpoint` needs no claim, on the
 * strength of an empty list, and three sessions were refused acting on them.
 * A rule that is enforced and undeclared is worse than one that is neither,
 * because it reads as a guarantee that it is absent.
 *
 * Takes the action so each operation's rule names what the caller was doing,
 * matching the refusal message they will actually be shown.
 */
export function assignmentRequiredRule(action: string): {
  readonly fields: readonly string[];
  readonly rule: string;
} {
  return {
    fields: ["itemId", "sessionId"],
    rule:
      `Requires YOUR OWN live assignment on this item — a row on \`Assignment\` matching both ` +
      `\`itemId\` and \`sessionId\` with \`releasedAt\` unset. This is a database check, so no ` +
      `schema can state it and a valid-looking call is refused with \`conflict\` when it is not ` +
      `met. Holding no assignment, ${action} has nothing to attribute to. If you were dispatched ` +
      `to this item and mean to hold it, take it first with \`ownership\` and ` +
      `\`action: "claim"\`. If you are reporting alongside the session that holds it, use ` +
      `\`note\`, which needs no assignment at all. An assignment that ` +
      `has been given up, or taken over after going quiet, also fails this — the refusal names ` +
      `which of those three cases you are in and what to do about it, including when taking it ` +
      `back would take the item from somebody.`,
  };
}
