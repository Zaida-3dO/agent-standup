// Who to credit an item mutation to — MILESTONES.md #102, SCHEMA.md §3.
//
// The four item-mutating operations (`create_item`, `update_item`,
// `transition_item`, `complete_item`) each wrote their `events` row with an
// inline `INSERT` whose column list stopped at
// `("itemId", "actorType", "actorId", "type", "payload")`. Three columns the
// table has were therefore never populated by those paths: `session_id`,
// `assignment_id` and `body`.
//
// That is not a cosmetic gap. `session_id` is what makes "who moved this"
// answerable, and the mutations it was missing from are precisely the ones
// most worth attributing — a state change with a null session is a state
// change nobody can be asked about. Routing these four through `appendEvent`
// closes it, because that function takes the whole `EventFields` shape and
// there is no column for a caller to forget.
//
// This module exists so the *attribution* half is decided once. Deriving the
// actor from a `Caller` is a two-line expression, and two lines copied four
// times is four places to disagree about what a missing actor means.
import type { Caller, TransactionHandle } from "../context";
import type { EventActor } from "@/lib/events";

/**
 * The `EventActor` a `Caller` describes.
 *
 * `system` when the caller names no actor, `agent` otherwise — the same
 * reading the four inline inserts each made for themselves, and the same one
 * `settings-shared.ts` makes for setting changes. It is preserved rather than
 * improved on deliberately: this row is about which columns get written, and
 * changing who an event is attributed to at the same time would make any
 * difference in the ledger impossible to attribute to either change.
 *
 * **`sessionId` is the column this row exists to stop losing.** It was
 * available at all four call sites the whole time — `ctx.caller.sessionId` —
 * and simply had nowhere to go in a five-column insert.
 */
export function callerEventActor(caller: Caller): EventActor {
  return {
    actorType: caller.actor ? "agent" : "system",
    actorId: caller.actor ?? null,
    sessionId: caller.sessionId ?? null,
  };
}

interface AssignmentIdRow {
  id: string;
}

/**
 * The id of the live assignment this caller's session holds on `itemId`, or
 * `null`.
 *
 * "Live" is `releasedAt IS NULL`, the same test `claim`, `release`,
 * `heartbeat`, `checkpoint` and `note` each make. A released assignment is
 * not one: crediting it would attach a finished session's identity to work
 * done after it let go.
 *
 * Returns `null` rather than throwing when there is no assignment, because
 * these four operations do not *require* one. A person editing an item from
 * the board holds nothing, and refusing their edit for want of an assignment
 * would be a new restriction this row has no business introducing. The
 * attribution is a courtesy where it is available — exactly the shape `note`
 * already uses, and deliberately not `checkpoint`'s, which does require one.
 */
export async function liveAssignmentId(
  db: TransactionHandle,
  itemId: string,
  caller: Caller,
): Promise<string | null> {
  if (!caller.sessionId) {
    return null;
  }
  const rows = await db.$queryRawUnsafe<AssignmentIdRow[]>(
    `SELECT "id" FROM "Assignment"
      WHERE "itemId" = $1 AND "sessionId" = $2 AND "releasedAt" IS NULL
      LIMIT 1`,
    itemId,
    caller.sessionId,
  );
  return rows[0]?.id ?? null;
}
