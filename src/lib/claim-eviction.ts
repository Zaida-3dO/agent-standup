// Lazy eviction of stale claims — reclaiming an item at the moment another
// session actually wants it (SCHEMA.md §2; the counterpart to the periodic
// ladder in liveness.ts).
//
// ── The problem ────────────────────────────────────────────────────────
//
// A claim is an `INSERT ... ON CONFLICT DO NOTHING` against two partial
// unique indexes, so a session that claims an item and then dies holds it
// forever: every later claim conflicts with a row nothing will ever
// release. Whether a session *looks* dead is a pure function of how long it
// has been quiet and needs no timer to compute — but computing it frees
// nothing on its own. Something has to perform the release, and that is the
// only reason this deployment ever needed a scheduler.
//
// This module is the release, performed at the point of contention. When a
// claim is refused because somebody already holds the item, the holder is
// judged here; if the evidence says it is gone, its row is released and the
// claim is retried. The check happens exactly when the answer matters and
// is correct by construction at that instant, rather than on a tick that
// may run long before or long after anyone cares.
//
// ── The evidence problem, stated honestly ──────────────────────────────
//
// **This is the part that constrains the whole design, and it is not what
// the documentation says.**
//
// `Assignment.lastActive` is described in SCHEMA.md §2 as "stamped by the
// hook on every tool call — free, no agent effort". In this tree it is not.
// The only writer of that column anywhere in the source is the `heartbeat`
// operation, whose own summary reads "Usually unnecessary — the hook does
// it" — and the hook does not: `src/bin/standup-hook.ts` and
// `src/lib/hook/**` never touch it, and `record_tool_calls` reads the
// assignment without stamping it. So `lastActive` is, for a session that
// does not explicitly call `heartbeat`, **frozen at the moment of the
// claim**.
//
// `liveness.stale_after_seconds` says a process check "comes first" and
// that the timeout is "the fallback for when that cannot answer". There is
// no process check. Nothing in this repository consults the operating
// system about whether a holder's pid is running; `registered_processes`
// records processes an agent *started*, not the agent itself, and carries
// no row for the session holding a claim.
//
// The consequence is the single most important fact about this file: **with
// only `lastActive` to read, a session that claims an item and then
// legitimately works for half an hour is indistinguishable from one that
// crashed a second after claiming.** At the sweep's thresholds (900s
// stalled, 1800s dead) that is not hypothetical — half an hour of honest
// work is the *normal* case for a builder, and evicting it would release a
// claim out from under a running agent, which is the failure this system
// exists to prevent.
//
// ── What is therefore treated as evidence ──────────────────────────────
//
// Eviction requires evidence that a holder is gone. Quiet is not evidence;
// it is the absence of evidence, and the two are only the same thing when
// activity is reliably recorded, which here it is not. So this module
// evicts on the conjunction of three conditions, and each one is doing
// distinct work:
//
//   1. **The holder has not been seen for `evict_after_seconds`**, measured
//      as the *most recent* of `lastActive` and the session's newest
//      `ToolCall.ts`. `ToolCall` rows are written by a genuinely different
//      mechanism — the hook's spool, flushed through `record_tool_calls` —
//      so consulting them is not a second reading of the same signal. It is
//      the closest thing this deployment has to the process check the
//      settings text promises, and for any session running the hook it is
//      the signal that actually moves. A session heartbeating, a session
//      making tool calls, or a session doing either, all count as seen.
//
//   2. **The threshold is its own setting, defaulted far higher than the
//      sweep's `dead_after_seconds`.** Not a reuse of it. The sweep's
//      thresholds were chosen for a signal that was supposed to be stamped
//      on every tool call; this one has to be safe against a signal that
//      may be stamped once, ever. Four hours is longer than any single
//      agent turn observed in this system and is deliberately biased
//      towards leaving a stranded claim stranded rather than evicting a
//      working builder. A stranded claim is visible, diagnosable and
//      recoverable by hand through `takeover`; a builder evicted mid-run
//      loses uncommitted work and produces two sessions that each believe
//      they own the item, which is neither visible nor recoverable.
//
//   3. **The claim must be at least that old too.** A holder whose row was
//      inserted five minutes ago cannot have been quiet for four hours no
//      matter what its other timestamps say, so a clock skew, a restored
//      backup or an imported row cannot manufacture an eviction. This is a
//      cheap consistency check against the one input class that is not a
//      measurement of the holder's own behaviour.
//
// ── The residual hole, stated because it is the one that bites ─────────
//
// **These three are NOT jointly sufficient in every case, and the exception
// is precise.** `claimedAt` and `lastActive` both default to `now()` at
// insert. So for a session running **no hook** (therefore writing no
// `ToolCall` rows) that also never calls `heartbeat`, both terms are
// computed from the same instant: `unseenForSeconds == claimAgeSeconds`,
// and condition 3 is not an independent check at all. Such a session on a
// single turn longer than the threshold **can be evicted while alive.**
//
// Condition 3 still does its other job in that case — it defends against
// clock skew, restores and imported rows, which is why it stays — but it is
// not a second liveness signal there, and reading it as one is the mistake
// this paragraph exists to prevent.
//
// That is the whole of the exposure, and it is why the default threshold is
// four hours rather than something tuned to the sweep. **Anyone lowering
// this threshold is trading directly against that case**, so the two facts
// belong next to each other. It closes on its own the moment either the
// hook stamps `lastActive` or any tool-call telemetry reaches the server,
// because condition 1 then has a signal that moves independently of the
// claim.
//
// **What this deliberately does not do.** It does not evict a holder that
// is merely `stalled`, and it does not treat the sweep's `dead` rung as
// sufficient on its own — the rung is computed from `lastActive`, which is
// the signal known to be unreliable, so a `dead` rung reached at 1800s of a
// column that never moves is exactly the false positive this module must
// not act on. `liveness` is read only as a *corroborating* signal: a row
// already `superseded`, or already released, needs no fresh judgement
// because something else has already decided.
//
// **What is given up by being this conservative.** An item whose holder
// died twenty minutes ago stays held for the rest of the four hours. That
// is a real cost and it is the intended trade: `takeover` remains reachable
// for exactly this case, it names the holder in its refusal, and forcing it
// costs one sentence of written reason. The lazy path is for the unattended
// case where nobody is there to write that sentence.
//
// **When the hook does start stamping `lastActive`**, this threshold should
// come down — probably to something near `dead_after_seconds`. That is a
// one-line settings change, and it is the reason this is a setting rather
// than a constant. Until then the default encodes the deployment as it
// actually is rather than as the documentation describes it.
import { appendEvent } from "./events";
import type { TransactionHandle } from "./service/context";
import type { Assignment } from "./claims";

/**
 * How a holder was judged when a competing claim arrived.
 *
 * Every value other than `evictable` is a reason *not* to evict, kept
 * distinct rather than collapsed to a boolean because the refusal path
 * reports which one applied — "held by a session seen 40 seconds ago" and
 * "held by a row something else already released" send a caller to
 * different next steps.
 */
export type EvictionVerdict =
  /** Something already decided: released, or superseded by a takeover. */
  | "already_released"
  /** Seen recently enough that eviction could interrupt live work. */
  | "recently_seen"
  /** Quiet long enough, and the claim is old enough for that to be meaningful. */
  | "evictable";

export interface EvictionJudgement {
  readonly verdict: EvictionVerdict;
  /**
   * Seconds since the holder was last seen by *any* signal, or `null` when
   * the verdict did not need to consult the clock.
   */
  readonly unseenForSeconds: number | null;
  /** Which signal was most recent. Reported so a refusal can say what it read. */
  readonly lastSeenSignal: "heartbeat" | "tool_call" | null;
}

export interface EvictionInputs {
  readonly liveness: Assignment["liveness"];
  readonly releasedAt: Date | null;
  /** `Assignment.lastActive` — written only by `heartbeat` in this tree. */
  readonly lastActive: Date;
  /** `Assignment.claimedAt` — the floor on how long this row can have been quiet. */
  readonly claimedAt: Date;
  /**
   * The session's most recent `ToolCall.ts`, or null when it has none. The
   * independent signal; see this module's header.
   */
  readonly lastToolCallAt: Date | null;
  readonly now: Date;
  readonly evictAfterSeconds: number;
}

/**
 * Judges whether a holder is gone, given the evidence.
 *
 * Pure, and separated from the write for the same reason `nextLivenessRung`
 * and `judgeHolder` are: every interesting case is a boundary, and a
 * boundary tested through a database is tested by whatever `now` the test
 * happened to construct.
 */
export function judgeEviction(input: EvictionInputs): EvictionJudgement {
  // Nothing left to evict — something else already decided this row's fate.
  // Reported without consulting the clock at all, because no amount of
  // elapsed time could change the answer.
  if (input.releasedAt !== null || input.liveness === "superseded") {
    return { verdict: "already_released", unseenForSeconds: null, lastSeenSignal: null };
  }

  // The most recent of the two signals. `lastActive` is always present (it
  // defaults to the claim); a tool call may not be. Taking the max is what
  // makes a session that only ever produces one of the two still count as
  // seen — treating either signal alone as authoritative would evict a
  // session that is demonstrably making tool calls but never heartbeats,
  // which is every session running the hook.
  const heartbeatMs = input.lastActive.getTime();
  const toolCallMs = input.lastToolCallAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const lastSeenMs = Math.max(heartbeatMs, toolCallMs);
  const lastSeenSignal = toolCallMs > heartbeatMs ? "tool_call" : "heartbeat";

  const unseenForSeconds = (input.now.getTime() - lastSeenMs) / 1000;
  const claimAgeSeconds = (input.now.getTime() - input.claimedAt.getTime()) / 1000;

  // Both must clear the threshold. The claim-age term is not redundant with
  // the unseen term: `lastActive` and a tool-call timestamp are values a
  // client supplies or a restore can carry, while `claimedAt` is set by the
  // database on insert, so requiring both means no single bad timestamp can
  // manufacture an eviction on a claim that was made moments ago.
  if (unseenForSeconds < input.evictAfterSeconds || claimAgeSeconds < input.evictAfterSeconds) {
    return { verdict: "recently_seen", unseenForSeconds, lastSeenSignal };
  }

  return { verdict: "evictable", unseenForSeconds, lastSeenSignal };
}

/** One holder's row, plus the independent signal, as the eviction pass reads it. */
interface HolderRow {
  id: string;
  itemId: string;
  role: string;
  holderType: "person" | "agent";
  holderId: string;
  sessionId: string;
  liveness: Assignment["liveness"];
  releasedAt: Date | null;
  lastActive: Date;
  claimedAt: Date;
  lastToolCallAt: Date | null;
}

/** What one eviction released, reported so the caller can say what it did. */
export interface EvictedClaim {
  readonly assignmentId: string;
  readonly sessionId: string;
  readonly role: string;
  readonly unseenForSeconds: number;
}

/**
 * Releases every live assignment on `itemId` whose holder the evidence says
 * is gone, and returns what it released.
 *
 * **Runs inside the caller's transaction**, and the rows are read `FOR
 * UPDATE`. Both matter: the claim that triggered this is about to retry
 * against these same rows, so a holder that heartbeats between the
 * judgement and the release must not be evicted on the strength of a
 * staleness its heartbeat has already answered — locking the row is what
 * serialises the two. `FOR UPDATE OF a` restricts the lock to the
 * assignment; the `ToolCall` side is a correlated read, and locking it
 * would contend with the telemetry ingest for no benefit.
 *
 * **Every eviction is recorded as a `release` event**, never a silent
 * `UPDATE`. An item that changed hands with nothing in its history saying
 * why is the shape this codebase treats as worse than an outage — the next
 * reader sees work reassigned and has no way to learn whether that was a
 * decision or a defect. The event body states the evidence that was acted
 * on, so the judgement can be audited after the fact rather than re-derived
 * from timestamps that have since moved. It also carries the same honesty
 * `takeover` carries: releasing the row does not stop the holder.
 */
export async function evictStaleHolders(
  db: TransactionHandle,
  args: {
    readonly itemId: string;
    readonly evictAfterSeconds: number;
    /** The session whose claim triggered this, recorded on the event. */
    readonly bySessionId: string;
    readonly now?: Date;
  },
): Promise<EvictedClaim[]> {
  const now = args.now ?? new Date();

  // ⚠️ `FOR UPDATE OF a` IS LOAD-BEARING AND IS NOT COVERED BY A TEST.
  // Do not "simplify" it away: removing it leaves this file's whole suite
  // green, which is exactly why this comment exists instead of an assertion.
  //
  // **What it defends.** The transaction runs at Postgres default Read
  // Committed — no isolation level is set anywhere in the service layer — so
  // without the lock a holder that heartbeats in the window *between* the
  // read below and the release `UPDATE` further down is evicted on the
  // strength of a staleness its own heartbeat has already answered. That is
  // the live-builder eviction this module exists to prevent, arriving
  // through a door the pure judgement in `judgeEviction` cannot see. Locking
  // the row at the read is what serialises the two: the heartbeat waits, and
  // the eviction either wins outright or reads the updated row and declines.
  //
  // **Why there is no test.** The window that matters is interior to this
  // function, between its read and its write, and there is no seam to inject
  // a competing statement into it. A test that races a heartbeat from
  // outside can only fire once this function has returned — by which point
  // the release `UPDATE` holds a row lock of its own, so the heartbeat
  // blocks whether or not the read ever locked anything. Such a test passes
  // identically with and without `FOR UPDATE`; it was written, measured
  // against a lock-removed mutant, found to be exactly that hollow, and
  // removed rather than committed. Proving this properly needs an injectable
  // seam between the read and the write, which is a change to the shape of
  // this function and not worth making for the test alone.
  //
  // `OF a` restricts the lock to the assignment; the `ToolCall` side is a
  // correlated read, and locking it would contend with telemetry ingest for
  // no benefit.
  const rows = await db.$queryRawUnsafe<HolderRow[]>(
    `SELECT a."id", a."itemId", a."role"::text AS "role", a."holderType", a."holderId",
            a."sessionId", a."liveness", a."releasedAt", a."lastActive", a."claimedAt",
            (SELECT MAX(t."ts") FROM "ToolCall" t WHERE t."sessionId" = a."sessionId")
              AS "lastToolCallAt"
     FROM "Assignment" a
     WHERE a."itemId" = $1 AND a."releasedAt" IS NULL
     FOR UPDATE OF a`,
    args.itemId,
  );

  const evicted: EvictedClaim[] = [];

  for (const row of rows) {
    const judgement = judgeEviction({
      liveness: row.liveness,
      releasedAt: row.releasedAt,
      lastActive: row.lastActive,
      claimedAt: row.claimedAt,
      lastToolCallAt: row.lastToolCallAt,
      now,
      evictAfterSeconds: args.evictAfterSeconds,
    });

    if (judgement.verdict !== "evictable") continue;

    // `releasedAt` and `liveness` move in one statement, for the reason
    // `takeover` sets its three together: a released row still marked
    // `running` is a state nothing chose, and splitting the write is what
    // would allow it.
    await db.$executeRawUnsafe(
      `UPDATE "Assignment" SET "releasedAt" = $1, "liveness" = 'dead'::"Liveness" WHERE "id" = $2`,
      now,
      row.id,
    );

    const unseenForSeconds = Math.round(judgement.unseenForSeconds ?? 0);

    await appendEvent(db, {
      itemId: row.itemId,
      actor: { actorType: "system", actorId: null },
      assignmentId: row.id,
      type: "release",
      payload: { assignmentId: row.id, role: null, holderId: row.holderId },
      body:
        `Released automatically at contention: session ${row.sessionId} held this as ${row.role} ` +
        `and has not been seen for ${unseenForSeconds}s (threshold ${args.evictAfterSeconds}s, ` +
        `most recent signal ${judgement.lastSeenSignal ?? "none"}), so the claim by session ` +
        `${args.bySessionId} reclaimed it. If that session is in fact still running, it is NOT ` +
        `stopped — nothing refuses its tool calls — and two sessions may now believe they own ` +
        `this item.`,
    });

    evicted.push({
      assignmentId: row.id,
      sessionId: row.sessionId,
      role: row.role,
      unseenForSeconds,
    });
  }

  return evicted;
}
