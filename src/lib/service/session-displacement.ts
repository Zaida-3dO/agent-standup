// Telling a session that its claim was taken from it.
//
// Taking an item over records the displacement and releases the assignment;
// it cannot stop the session it displaced. That session keeps its context,
// its subagents and its write access, and it goes on calling tools against a
// claim that has been released out from under it — so the board shows one
// crew where two are working, and the two can build to different
// conclusions.
//
// The gap is not that the fact is unrecorded. It is recorded, durably and in
// full: `takeoverAssignment` writes `supersededBy` and `liveness =
// 'superseded'` in one statement precisely so a reader can find out who took
// the item and when. What was missing is a reader — nothing on the session's
// own path ever looked.
//
// This module is that reader. It answers one question, for one session:
// **has this session's claim been taken, and by whom?**
//
// ── Why the answer travels on the hook's response ──────────────────────
//
// A notice aimed at one session needs a channel that session is already
// listening on. It has exactly one: the hook calls `POST /api/hook` before
// every tool call and renders what comes back. So the notice rides that
// response, and the consumer already exists — `readSessionStatus` reads an
// `enforcement` field off the body and `enforcementRefusal` turns a
// `displaced` status into a refusal (`src/lib/hook/enforcement.ts`).
//
// The alternatives were weighed and are worth recording, because both look
// reasonable until the details are checked:
//
//   - **A pending-notices table, drained on the session's next call.** A
//     migration, a drain and a retention rule, all to carry a fact two
//     columns on `Assignment` already hold. A second copy of a truth is a
//     second thing that can disagree with it, and this one would have no
//     way to be repaired if it did.
//   - **The telemetry spool.** It reaches the server on the same events, so
//     it looks like a channel that already exists. It is not one, for two
//     independent reasons: the flush is fire-and-forget and its response is
//     never rendered into the session's output, and the row it locates is
//     filtered on `releasedAt IS NULL` — which a superseded assignment
//     never satisfies, so it cannot see a displacement at all.
//
// ── What this costs, which is the whole design constraint ──────────────
//
// A hook decision is the highest-volume path in the system, and it stays
// query-free for the overwhelming majority of calls: a `Read`, an `ls` or an
// `Edit` reaches no table, because the intervention context gates its
// queries on the command's shape. Displacement cannot be gated that way —
// it is a fact about the *session*, and a displaced agent's next call is
// overwhelmingly likely to be something ordinary — so gating on the command
// would miss exactly the case this exists to catch.
//
// It is therefore gated on the **phase** instead, which costs nothing to
// evaluate and drops the volume by roughly a third: only `PreToolUse` asks.
// A `PostToolUse` and a `Stop` describe a call that has already run, and
// telling a session to stop a call it has finished is a refusal that cannot
// be honoured — the hook enforces the same rule independently, so a notice
// on those phases would be discarded on arrival.
//
// What one `PreToolUse` pays is a single index lookup on
// `Assignment_sessionId_idx`, an index that already exists for the claim
// read. Not a second query added beside that one: the ordinary call the
// claim read is skipped for is precisely the call this one runs on, so the
// two are alternatives far more often than they are additions.
import type { TransactionHandle } from "./context";

/** What the hook is told about a session, mirroring the shape the script reads. */
export interface SessionEnforcementPayload {
  readonly status: "displaced";
  readonly detail: string;
}

/**
 * One superseded assignment, as the lookup reads it.
 *
 * Every field but the item is optional as well as nullable, and that is
 * about the driver rather than about the schema. A raw query hands back
 * whatever columns the statement selected; a value that is absent and one
 * that is SQL `NULL` arrive as `undefined` and `null` respectively, and code
 * that checked only for `null` would read the first as a `Date` and call a
 * method on nothing. Treating the two the same at the boundary is what keeps
 * the difference from reaching the sentence.
 */
interface DisplacedRow {
  readonly itemId: string;
  readonly supersededBy?: string | null;
  readonly releasedAt?: Date | null;
}

/**
 * The sentence a displaced session is shown, naming who and when.
 *
 * Both facts are load-bearing rather than decorative, which is why this is a
 * function over them and not a constant. **Who** is what lets the displaced
 * session hand over to a specific counterpart instead of merely stopping;
 * **when** is what lets it tell work it did before the takeover from work it
 * did after, which is the part it has to report on.
 *
 * A missing value is written as an explicit unknown rather than omitted. The
 * columns are nullable and a takeover always writes them, so absence here
 * means something upstream is wrong — and a sentence that quietly renders a
 * shorter version of itself would hide that, while a reader who is told the
 * holder is unknown at least knows what to go and ask.
 */
export function displacedDetail(args: {
  readonly itemId: string;
  readonly bySessionId?: string | null;
  readonly at?: Date | null;
}): string {
  const by = args.bySessionId ?? "an unrecorded session";
  // `instanceof` rather than a null check: this value comes off a raw query,
  // so it can be absent, `null`, or — depending on how the column is read
  // back — a string that has not been revived into a `Date`. Asking whether
  // it is actually a `Date` covers all three at once, where a `!== null`
  // test would pass a string through to `.toISOString()` and throw inside
  // the hook's own path.
  const at = args.at instanceof Date ? args.at.toISOString() : "an unrecorded time";
  return `Item ${args.itemId} was taken over by session ${by} at ${at}.`;
}

/**
 * Looks up whether this session has been displaced, for the hook to report.
 *
 * Reads the newest superseded assignment rather than any of them: a session
 * that held several items over its life may have been displaced on more than
 * one, and the most recent displacement is the one it has not yet reacted
 * to. Older ones describe work it has already stopped doing.
 *
 * **A released assignment is not by itself a displacement.** `liveness =
 * 'superseded'` is required, and it is the discriminator that matters: an
 * ordinary `release` also sets `releasedAt`, and reading that as a takeover
 * would refuse every session that had politely finished its work — turning a
 * notice that should fire rarely into one that fires on the common path.
 *
 * Returns `undefined` for the ordinary session, which is the value the hook
 * reads as "nothing said about this session" and passes through untouched.
 */
export async function displacementFor(
  db: TransactionHandle,
  sessionId: string,
): Promise<SessionEnforcementPayload | undefined> {
  const rows = await db.$queryRawUnsafe<DisplacedRow[]>(
    `SELECT a."itemId"       AS "itemId",
            a."supersededBy" AS "supersededBy",
            a."releasedAt"   AS "releasedAt"
       FROM "Assignment" a
      WHERE a."sessionId" = $1
        AND a."liveness" = 'superseded'
      ORDER BY a."releasedAt" DESC
      LIMIT 1`,
    sessionId,
  );

  const displaced = rows[0];
  if (displaced === undefined) return undefined;
  // A row with no item is not a displacement anyone can act on: the item is
  // the only part of the sentence that tells the session *which* work to
  // stop. Refusing to speak is better than naming an `undefined` item, which
  // would stop a session and give it nothing to hand over.
  if (typeof displaced.itemId !== "string" || displaced.itemId === "") return undefined;

  return {
    status: "displaced",
    detail: displacedDetail({
      itemId: displaced.itemId,
      bySessionId: displaced.supersededBy,
      at: displaced.releasedAt,
    }),
  };
}
