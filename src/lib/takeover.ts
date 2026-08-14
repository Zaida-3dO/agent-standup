// Takeover — displacing a live assignment so a stranded item can move again
// (SCHEMA.md §2's supersession path; MILESTONES.md #99).
//
// **The problem this exists to solve.** A claim is an `INSERT ... ON CONFLICT
// DO NOTHING` against two partial unique indexes, so a session that holds an
// item and then dies holds it forever: every later claim conflicts with a row
// nothing will ever release. The liveness sweep releases such rows once they
// pass the dead threshold, which handles the *patient* case. This module
// handles the case where waiting is not acceptable — and, more importantly,
// the case the sweep will never handle at all, because the holder is
// genuinely still alive.
//
// **Two paths, deliberately asymmetric.**
//
//   - **The holder is dead** (the ladder says `dead`, or the row is already
//     released). Nothing is being interrupted, so there is nothing to warn
//     about: takeover is a clean, unceremonious handover.
//   - **The holder may be alive** (`running` or `stalled`). Takeover is still
//     *allowed* — a caller who knows the holder is gone, or who has been told
//     to take the work, must not be stuck behind a rule the system cannot
//     verify. But it is deliberately loud: it demands an explicit `force`, it
//     demands a written `reason`, and it refuses without either, quoting the
//     warning rather than merely failing. The asymmetry is the whole design —
//     the easy path is the safe one, and the dangerous one costs a sentence.
//
// **`stalled` counts as possibly-alive, not as dead.** SCHEMA.md §2 says
// supersession requires `stalled` or `dead`, which is about what *may* be
// superseded; it is not a claim that a stalled session has stopped. A stalled
// session is one that has been quiet, and quiet is not the same as gone — the
// sweep itself will move it back to `running` on its next tool call. So
// `stalled` is on the loud path.
//
// **What is recorded, and why in this shape.** A takeover writes three
// things, all inside the caller's transaction:
//
//   1. `Assignment.supersededBy` = the taking session, and `liveness` =
//      `superseded`, and `releasedAt` = now. §2's first invariant is that a
//      superseded assignment is never `running` again; setting all three in
//      one statement is what makes "superseded and alive" unrepresentable
//      rather than merely discouraged.
//   2. A `takeover` event carrying `{assignment_id, role, holder_id}` — §3's
//      declared payload for this type — extended with who took over, from
//      whom, and whether the holder was believed alive. The reason goes in
//      `body`, where §3 puts prose.
//   3. Nothing else. In particular the taking session does **not** get an
//      assignment here: claiming is `claimItem`'s job and has its own guards,
//      and a takeover that also claimed would be two operations wearing one
//      name — the caller claims immediately afterwards, through the front
//      door, now that the conflicting row is released.
//
// **What this module does NOT do, stated plainly because it is the half a
// reader will assume is here.** Displacing a live session records that it was
// displaced; it does not *stop* it. The displaced session's next tool call is
// refused only once something reads this state and refuses on it — that
// enforcement lives in the tool-call hook, which is a separate piece of work
// and does not exist yet. Until it does, a displaced-but-alive session keeps
// running and keeps making calls; what a takeover achieves on its own is that
// the assignment stops being live, so that session cannot win a claim and the
// record says who displaced it and why. `supersededBy` + `liveness =
// 'superseded'` is precisely the
// state that hook will read, which is why it is written in full now rather
// than left for the hook to invent.
import { ConflictError, GuardRejectedError, NotFoundError } from "./service/errors";
import { appendEvent } from "./events";
import { nextLivenessRung } from "./liveness";
import type { Assignment } from "./claims";
import type { TransactionHandle } from "./service/context";

/** The guard identifier a takeover of a possibly-live holder rejects under when unforced. */
export const LIVE_HOLDER_GUARD = "takeover.live_holder_needs_force";

/** The guard identifier a forced takeover with no stated reason rejects under. */
export const REASON_REQUIRED_GUARD = "takeover.reason_required";

/**
 * The warning a caller sees when it tries to displace a possibly-live holder
 * without forcing.
 *
 * Written out as a constant rather than inline so a test asserts the caller
 * is actually told the three things that make the refusal actionable — that
 * it is dangerous, that a good reason is required, and what the usual valid
 * one is — rather than merely that *some* string came back. A refusal whose
 * message can quietly degrade to "forbidden" has lost the only part of it
 * that does any work.
 */
export const LIVE_TAKEOVER_WARNING =
  "DANGEROUS: this holder may still be alive and working. " +
  "Taking over from a live session can lose its uncommitted work and leave two sessions " +
  "believing they own the same item. Do NOT do this unless you have a genuinely good reason — " +
  "in practice the only usually-valid one is that the person running this system told you to. " +
  "If you are sure, retry with force: true and a reason saying why.";

/** How alive the holder was judged to be at the moment of the takeover. */
export type HolderLiveness = "dead" | "possibly_alive";

export interface TakeoverInput {
  readonly itemId: string;
  /** The session being displaced. Named explicitly so a caller cannot take over "whoever happens to hold this". */
  readonly fromSessionId: string;
  /** The session taking over. */
  readonly bySessionId: string;
  /** Who the taking session acts as — recorded on the event as the actor. */
  readonly byHolderType: "person" | "agent";
  readonly byHolderId: string;
  /** Required whenever the holder may be alive; recorded either way when supplied. */
  readonly reason?: string | null;
  /** Acknowledges the warning. Ignored when the holder is already dead — there is nothing to force. */
  readonly force?: boolean;
}

export interface TakeoverResult {
  /** The assignment as it stands after being superseded. */
  readonly superseded: Assignment;
  /** How alive the holder was judged to be — the branch that was taken. */
  readonly holderLiveness: HolderLiveness;
  /** True when the caller had to acknowledge the warning to get here. */
  readonly forced: boolean;
  readonly reason: string | null;
  /**
   * The honest statement of what has and has not happened, handed back to the
   * caller rather than left in a document it may not read. See this module's
   * header: the record is written, the displaced session is not stopped.
   */
  readonly enforcementNote: string;
}

export const ENFORCEMENT_NOTE =
  "The takeover is recorded and the assignment is released, so this item can be claimed again. " +
  "The displaced session is NOT prevented from continuing: nothing yet refuses its tool calls. " +
  "If it may still be running, tell it directly.";

/**
 * Decides whether a holder should be treated as dead, given how long it has
 * been quiet and the configured thresholds.
 *
 * Pure and separated from the write for the same reason `nextLivenessRung` is
 * separated from `sweepLiveness`: the interesting cases are boundaries, and a
 * boundary tested through a database is tested by whatever `now` the test
 * happened to construct. A row already released is dead by definition — there
 * is no holder left to interrupt — and is reported as such without consulting
 * the clock at all.
 */
export function judgeHolder(args: {
  readonly liveness: Assignment["liveness"];
  readonly releasedAt: Date | null;
  readonly quietForSeconds: number;
  readonly staleAfterSeconds: number;
  readonly deadAfterSeconds: number;
}): HolderLiveness {
  if (args.releasedAt !== null) return "dead";
  if (args.liveness === "dead" || args.liveness === "superseded") return "dead";
  const rung = nextLivenessRung({
    quietForSeconds: args.quietForSeconds,
    staleAfterSeconds: args.staleAfterSeconds,
    deadAfterSeconds: args.deadAfterSeconds,
  });
  return rung === "dead" ? "dead" : "possibly_alive";
}

/**
 * Refuses a takeover of a possibly-live holder that has not acknowledged the
 * warning, and one that has acknowledged it but stated no reason.
 *
 * Both directions are refused, and the order matters: `force` without a
 * `reason` is refused as *missing a reason*, not as unforced, because telling
 * a caller to set a flag it has already set sends it to fix the wrong thing.
 *
 * A dead holder passes both — that is the entire point of the asymmetry — and
 * that includes a dead holder with no reason given. Requiring paperwork to
 * reclaim an item from a session that has demonstrably stopped is friction
 * that buys nothing and would push callers towards forcing everything.
 */
export function assertTakeoverAllowed(args: {
  readonly holderLiveness: HolderLiveness;
  readonly force: boolean;
  readonly reason: string | null;
  readonly itemId: string;
  readonly fromSessionId: string;
}): void {
  if (args.holderLiveness === "dead") return;

  if (!args.force) {
    throw new GuardRejectedError(
      LIVE_HOLDER_GUARD,
      `Session ${args.fromSessionId} still holds ${args.itemId} and has not been quiet long ` +
        `enough to be treated as dead. ${LIVE_TAKEOVER_WARNING}`,
      {
        fields: ["force", "reason"],
        details: {
          itemId: args.itemId,
          heldBy: args.fromSessionId,
          holderLiveness: "possibly_alive",
        },
      },
    );
  }

  if (!args.reason?.trim()) {
    throw new GuardRejectedError(
      REASON_REQUIRED_GUARD,
      `Taking ${args.itemId} from a possibly-live session requires a written reason — it is ` +
        `recorded against the displaced session permanently, and it is the only thing that ` +
        `tells the next reader whether this was deliberate. Typical reasons: the person running ` +
        `this system told you to work on it now; you know the other agent is dead.`,
      {
        fields: ["reason"],
        details: { itemId: args.itemId, heldBy: args.fromSessionId },
      },
    );
  }
}

/**
 * Takes an item over from another session.
 *
 * Runs entirely inside the caller's transaction. The row is read, judged and
 * updated in one boundary, so a holder that heartbeats between the judgement
 * and the write cannot end up superseded on the strength of a staleness the
 * heartbeat has already answered — the read takes the row's lock the update
 * needs anyway.
 */
export async function takeoverAssignment(
  db: TransactionHandle,
  settings: {
    readonly staleAfterSeconds: number;
    readonly deadAfterSeconds: number;
  },
  input: TakeoverInput,
  options: { readonly now?: Date } = {},
): Promise<TakeoverResult> {
  const now = options.now ?? new Date();
  const reason = input.reason?.trim() ? input.reason.trim() : null;

  // `FOR UPDATE` rather than a plain read: two sessions racing to take the
  // same holder over would otherwise both read a live row, both judge it, and
  // both write — leaving two `takeover` events claiming the same displacement
  // and the second silently overwriting the first's `supersededBy`. Locking
  // the row serialises them, so the loser reads the already-superseded row and
  // is refused by the `releasedAt` check below.
  const rows = await db.$queryRawUnsafe<Assignment[]>(
    `SELECT * FROM "Assignment"
     WHERE "itemId" = $1 AND "sessionId" = $2
     ORDER BY "claimedAt" DESC
     LIMIT 1
     FOR UPDATE`,
    input.itemId,
    input.fromSessionId,
  );
  const holder = rows[0];
  if (!holder) {
    throw new NotFoundError(
      `Session ${input.fromSessionId} has no assignment on ${input.itemId} to take over.`,
      { fields: ["itemId", "fromSessionId"] },
    );
  }

  if (holder.sessionId === input.bySessionId) {
    // Self-takeover is refused rather than treated as a no-op: a session
    // asking to displace itself has confused which session it is, and quietly
    // superseding its own live row would release the claim it is holding.
    throw new ConflictError(
      `Session ${input.bySessionId} cannot take over from itself on ${input.itemId}.`,
      { fields: ["fromSessionId", "bySessionId"] },
    );
  }

  if (holder.releasedAt !== null) {
    // Nothing to take over — the row is already released, by the sweep, by a
    // voluntary release, or by an earlier takeover. Reported rather than
    // absorbed: the caller's next step is to claim, and telling it the claim
    // is already available is more useful than pretending a takeover happened.
    throw new ConflictError(
      `Session ${input.fromSessionId} does not hold ${input.itemId}: its assignment was ` +
        `released at ${holder.releasedAt.toISOString()}. Claim it directly.`,
      {
        fields: ["itemId", "fromSessionId"],
        details: { releasedAt: holder.releasedAt.toISOString(), liveness: holder.liveness },
      },
    );
  }

  const holderLiveness = judgeHolder({
    liveness: holder.liveness,
    releasedAt: holder.releasedAt,
    quietForSeconds: (now.getTime() - holder.lastActive.getTime()) / 1000,
    staleAfterSeconds: settings.staleAfterSeconds,
    deadAfterSeconds: settings.deadAfterSeconds,
  });

  assertTakeoverAllowed({
    holderLiveness,
    force: input.force ?? false,
    reason,
    itemId: input.itemId,
    fromSessionId: input.fromSessionId,
  });

  // One statement sets all three fields. Splitting them would allow a
  // `superseded` row that is still live, which is exactly the state §2's
  // first invariant says must not exist.
  const updated = await db.$queryRawUnsafe<Assignment[]>(
    `UPDATE "Assignment"
     SET "liveness" = 'superseded'::"Liveness", "supersededBy" = $1, "releasedAt" = $2
     WHERE "id" = $3
     RETURNING *`,
    input.bySessionId,
    now,
    holder.id,
  );
  const superseded = updated[0];
  if (!superseded) {
    // Unreachable in practice — the row was read `FOR UPDATE` in this same
    // transaction. Guarded rather than asserted, following `release.ts`.
    throw new NotFoundError(`Assignment ${holder.id} disappeared mid-takeover.`, { fields: [] });
  }

  await appendEvent(db, {
    itemId: holder.itemId,
    actor: {
      actorType: input.byHolderType,
      actorId: input.byHolderId,
      sessionId: input.bySessionId,
    },
    assignmentId: holder.id,
    type: "takeover",
    payload: {
      // §3's declared payload for `takeover`, describing the assignment that
      // was taken — followed by what is specific to *this* event.
      assignmentId: holder.id,
      role: holder.role,
      holderId: holder.holderId,
      fromSessionId: holder.sessionId,
      bySessionId: input.bySessionId,
      byHolderId: input.byHolderId,
      holderLiveness,
      forced: holderLiveness === "possibly_alive",
    },
    body:
      reason ??
      `Taken over from a session past the dead threshold (quiet since ${holder.lastActive.toISOString()}).`,
  });

  return {
    superseded,
    holderLiveness,
    forced: holderLiveness === "possibly_alive",
    reason,
    enforcementNote: ENFORCEMENT_NOTE,
  };
}
