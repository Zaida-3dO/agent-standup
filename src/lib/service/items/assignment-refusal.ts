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
        `Use note to record what you have, and check with whoever dispatched you.`,
    };
  }

  if (prior) {
    return {
      case: "released_free",
      message:
        `Your assignment on ${itemId} was released, so ${action} has nothing to attribute to. ` +
        `No other session holds this item, so claiming it again is safe and is the intended ` +
        `recovery — a claim that goes quiet for long enough is reclaimed, and a long silent ` +
        `stretch of work looks the same as a session that died. Claim it again and carry on.`,
    };
  }

  return {
    case: "never_held",
    message:
      `Session ${sessionId} has never held an assignment on ${itemId}, and ${action} attributes ` +
      `to one. If you were dispatched to work on this item, claim it first; if you are reporting ` +
      `alongside a session that holds it, use note instead — note needs no assignment.`,
  };
}
