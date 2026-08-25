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
// hook on every tool call — free, no agent effort". **It is stamped by
// `record_tool_calls`, but read that claim narrowly.** The stamp rides on
// the statement that resolves the session's *live assignment*, so it moves
// for a session flushing telemetry **while holding a claim**, and moves
// nothing for a session that holds none. It is a genuine liveness signal
// for exactly the population this module judges — claim holders — and it is
// not the blanket guarantee §2's wording suggests. Before that change the
// only writer anywhere in the source was the `heartbeat` operation, whose
// own summary read "Usually unnecessary — the hook does it" while the hook
// did not, and this module's conservatism was built on that fact.
//
// `ToolCall` rows are the separate half and are written unconditionally,
// claim or no claim, which is why they are consulted here as an independent
// signal rather than as a second reading of the stamp.
//
// **What has not changed: there is still no process check.**
// `liveness.stale_after_seconds` used to say one "comes first" and that the
// timeout is "the fallback for when that cannot answer"; nothing in this
// repository consults the operating system about whether a holder's pid is
// running. `registered_processes` records processes an agent *started*, not
// the agent itself, and carries no row for the session holding a claim. The
// settings text has been corrected to say so rather than describe a
// mechanism that does not exist. A pid check was considered and declined
// deliberately: this server does not in general share a host with the
// sessions holding claims, so `kill(pid, 0)` would answer a question about
// the wrong machine — confidently, and wrongly, which is worse than not
// answering.
//
// The consequence that constrains this file therefore now applies to a
// **narrower** set of sessions than it once did, and naming that set
// precisely is the point: **a session that runs no hook and never calls
// `heartbeat` still writes neither signal**, so for it `lastActive` remains
// frozen at the claim and half an hour of honest work is indistinguishable
// from a crash a second after claiming. A session whose hook flushes is
// distinguishable, because its stamp moves. At the sweep's thresholds (900s stalled, 1800s
// dead) the distinction is not academic — half an hour of work is the
// *normal* case for a builder, and evicting it would release a claim out
// from under a running agent, which is the failure this system exists to
// prevent.
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
// ── The case the three conditions could not decide, and how it is now ──
//
// **Those three were NOT jointly sufficient, and the exception was
// precise.** `claimedAt` and `lastActive` are both `@default(now())` at
// insert. So for a session running **no hook** (writing no `ToolCall` rows,
// and therefore never reaching the stamp in `record_tool_calls`) that also
// never calls `heartbeat`, both terms were computed from the same instant:
// `unseenForSeconds == claimAgeSeconds`, and condition 3 was not an
// independent check at all. Such a session on a single turn longer than the
// threshold could be evicted while alive — the claim-age floor was the same
// signal read twice, not a second opinion.
//
// The fourth condition below is the answer, and it turns on a distinction
// the previous three could not draw:
//
//   4. **Silence is only evidence from a session that would otherwise
//      speak.** A holder that has emitted *no* signal since it claimed, and
//      whose registration says it has no hook to emit one with, is not
//      quiet because it died — it is quiet because that is the only way it
//      was ever going to be. Reading its silence as death is reading the
//      absence of a mechanism as the absence of a session. So that holder
//      is reported `never_signalled` and is not evicted on elapsed time.
//
// **This is a statement about the holder, not about the threshold.** The
// threshold is untouched, and lowering it was the tempting non-fix: a
// shorter fuse on a detector that cannot see the session it is judging just
// reaches the wrong answer sooner. What changed is that the detector now
// declines to answer where it has no evidence, instead of treating "nothing
// recorded" as "nothing happened".
//
// **What the server knows, and why `Session.hookVersion` is the right
// column.** SCHEMA.md §21 already defines a null `hookVersion` as a session
// that "makes no claim about what the session can enforce" — no
// registration at all, or a registration that named no version, collapse to
// the same fact, and `my_work` already reports exactly that collapse as its
// `hooked` flag. This reuses that reading rather than inventing a third
// one. A session that *did* register a hook version has a mechanism that
// stamps `lastActive` on every flush, so its silence is a real observation
// about a thing that should have been talking, and it is judged on elapsed
// time exactly as before.
//
// **The narrowness is deliberate and is what keeps eviction working.** The
// exemption requires BOTH halves. A holder that ever moved either signal —
// one `heartbeat`, one flushed tool call, at any point after the claim —
// has demonstrated it can be seen, so the exemption does not apply to it
// and it is evicted on the ordinary evidence when it goes quiet. That is
// the common case this mechanism exists for and it is preserved exactly: a
// crashed builder that was flushing telemetry right up to the moment it
// died still loses its claim at the threshold. What this rules out is
// evicting a session for failing to produce a signal it never had.
//
// **What is given up, named honestly.** An unhooked session that dies
// within its very first signal-less stretch holds its claim indefinitely
// rather than for four hours. That is a real regression in recovery for
// that one class, and it is the deliberate trade: the cost is a stranded
// claim, which is visible in `my_work`, diagnosable from the assignment row
// and recoverable by hand through `takeover` — a bounded, reversible,
// *noticed* failure. The cost on the other side was evicting a running
// builder, which produces two sessions that each believe they own the item
// and is neither visible nor recoverable. The asymmetry that justified four
// hours justifies this too, and further: it is the same argument carried to
// the case where the evidence is not merely thin but absent.
//
// **The escape is unchanged and now actually matters.** A signal-less
// session that wants its claim reclaimable can call `heartbeat` once; that
// single stamp moves `lastActive` off `claimedAt`, retires the exemption
// for that holder forever, and puts it back under ordinary judgement. So
// the exemption is not a permanent hiding place — it is the default for a
// session that has told the server nothing, and any session may leave it by
// saying one thing.
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
// ── On lowering the threshold ──────────────────────────────────────────
//
// **Do not lower it on the strength of the `record_tool_calls` stamp.**
// That reasoning stood here in an earlier revision, and it misled two
// separate pieces of work into believing this row was closed. The stamp is
// real, but three things that each looked like they should close the hole
// did not, and the reason is worth stating so a fourth attempt does not
// repeat them:
//
//   - Making `record_tool_calls` stamp `lastActive` helps only sessions
//     that already hold a claim, because the statement that stamps resolves
//     the session's live assignment and updates nothing when there is none.
//     Those are the sessions least at risk.
//   - Draining the hook's spool to the server helps for the same reason and
//     with the same limit.
//   - Wiring the hook at all does not help a session whose calls are reads:
//     a decision path that touches no `Assignment` row stamps no column.
//
// None of that reaches a session running **no hook**, which is the one the
// fourth condition is for. The threshold is therefore doing a different job
// now than it was: it is the margin for holders that *have* a signal and
// have gone quiet, not the sole protection for holders that never had one.
// It could reasonably come down once the population of claim-holding
// sessions is known to be hooked — but that is a deployment observation, to
// be made against the registry, and condition 4 rather than this number is
// what decides the case above. Shortening a fuse is not a fix for a
// detector that cannot see the session it is judging.
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
  /**
   * Has emitted no signal at all since claiming, and has no hook to emit
   * one with — so its silence is its configuration rather than evidence of
   * death. Distinct from `recently_seen` because the reason is different
   * and a caller acting on it should say so: this holder will never become
   * evictable through elapsed time alone, and `takeover` is the route.
   */
  | "never_signalled"
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
  /**
   * The holder declared a hook version and then emitted no signal at all
   * since claiming — a registration that misreports what the session can do.
   *
   * **This is a description of the holder, not a decision about it.** It is
   * never an input to the verdict: such a holder is `evictable` on the
   * ordinary evidence, and treating the discrepancy as a reason to protect
   * it would make declaring a hook you do not run strictly better than
   * declaring nothing, which is an incentive to misreport.
   *
   * `false` on every other path, including a signal-less holder that is
   * exempt (`never_signalled`) — that one declared nothing, so there is no
   * discrepancy between what it said and what it did.
   */
  readonly declaredHookNeverSignalled: boolean;
}

export interface EvictionInputs {
  readonly liveness: Assignment["liveness"];
  readonly releasedAt: Date | null;
  /**
   * `Assignment.lastActive` — written by `heartbeat`, and by
   * `record_tool_calls` on every telemetry flush. Still frozen at the claim
   * for a session that does neither; see this module's header.
   */
  readonly lastActive: Date;
  /** `Assignment.claimedAt` — the floor on how long this row can have been quiet. */
  readonly claimedAt: Date;
  /**
   * The session's most recent `ToolCall.ts`, or null when it has none. The
   * independent signal; see this module's header.
   */
  readonly lastToolCallAt: Date | null;
  /**
   * `Session.hookVersion` for the holder's session — null when it never
   * registered, or registered without naming a version. SCHEMA.md §21 reads
   * both as the same fact ("makes no claim about what the session can
   * enforce"), and `my_work` collapses them the same way for its `hooked`
   * flag.
   *
   * Consulted for one purpose only: deciding whether a holder that has
   * produced no signal *could* have produced one. A session with a hook
   * version has a mechanism that stamps `lastActive` on every flush, so its
   * silence is an observation; a session without one was never going to
   * stamp anything, so its silence is not.
   */
  readonly holderHookVersion: number | null;
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
    return {
      verdict: "already_released",
      unseenForSeconds: null,
      lastSeenSignal: null,
      declaredHookNeverSignalled: false,
    };
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
    // Deliberately `false` even for a declared-but-silent holder inside the
    // threshold. The discrepancy is only a fact once enough time has passed
    // that a hook would certainly have flushed; before that, silence from a
    // freshly-claimed session is ordinary and reporting it would cry wolf on
    // every claim made in the last four hours.
    return {
      verdict: "recently_seen",
      unseenForSeconds,
      lastSeenSignal,
      declaredHookNeverSignalled: false,
    };
  }

  // Condition 4 — the holder must be a session that *would* have been seen
  // had it been alive. Checked last, after the time terms, because it is the
  // more expensive fact to state and only matters once elapsed time has
  // already argued for eviction.
  //
  // Both halves are required, and each rules out a different mistake:
  //
  //   - `lastActive <= claimedAt` means the column still sits at its
  //     `@default(now())` — the holder has produced no heartbeat, and no
  //     telemetry flush landed while it held this claim. `<=` rather than
  //     `===` because the two defaults are evaluated by separate
  //     `now()` calls in one INSERT and a stamp can only ever move the
  //     column forward; an equality test would let a sub-millisecond
  //     ordering difference at insert decide a safety property.
  //   - No `ToolCall` row at all. A session with telemetry has a signal
  //     that moves whether or not it holds a claim, so its silence is real.
  //
  // …and then the registration must agree that there was no mechanism. A
  // holder that reported a hook version had something that stamps on every
  // flush; if that has produced nothing for four hours the honest reading is
  // that the session is gone, which is the case eviction exists for.
  const hasNeverSignalled =
    lastSeenMs <= input.claimedAt.getTime() && input.lastToolCallAt === null;

  if (hasNeverSignalled && input.holderHookVersion === null) {
    return {
      verdict: "never_signalled",
      unseenForSeconds,
      lastSeenSignal: null,
      declaredHookNeverSignalled: false,
    };
  }

  // The same silence, from a session whose registration said it had a hook.
  // This does NOT change the verdict — such a holder is evicted, exactly as
  // before — but it is a materially different eviction and the difference is
  // reported rather than left for a reader to re-derive from timestamps.
  //
  // The two are not the same event. An ordinary eviction says a session that
  // was demonstrably being seen stopped being seen, which is evidence it
  // died. This one says a session declared a mechanism for being seen and
  // then never used it once — so the eviction rests on a signal whose
  // absence was never explained, and the registration is the thing that is
  // wrong. On this deployment that is a reachable configuration rather than
  // a fanciful one: the hook is provisioned per-machine, it fails open, and
  // a session on an unprovisioned machine declares a version it will never
  // honour. Nothing else reports that discrepancy, so the eviction is the
  // one moment the server is certain of it and it is stated here.
  return {
    verdict: "evictable",
    unseenForSeconds,
    lastSeenSignal,
    declaredHookNeverSignalled: hasNeverSignalled,
  };
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
  holderHookVersion: number | null;
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

  // ⚠️ `FOR UPDATE OF a` IS LOAD-BEARING. Do not "simplify" it away — it is
  // now covered by "takes a ROW LOCK on its read" in tests/claim-eviction,
  // which fails when it is removed and when it is weakened to SKIP LOCKED.
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
  // **How it is tested, and why the obvious test does not work.** Racing a
  // heartbeat *inward* — starting this function, then firing a competing
  // statement at it — cannot reach the interior window: the racer only lands
  // once this function has returned, by which point the release `UPDATE`
  // holds a row lock of its own, so it blocks whether or not the read ever
  // locked anything. That test was written, measured against a lock-removed
  // mutant, found hollow, and deleted.
  //
  // The test that works races the other way: a rival transaction takes the
  // row lock **first**, then eviction runs, and the question becomes whether
  // *this* read waits. It does under `FOR UPDATE` and reads straight through
  // under Read Committed without it.
  //
  // The subtlety, measured rather than assumed: the holder in that test must
  // be **live, not stale**. With a stale holder the judgement says "evict",
  // the release `UPDATE` runs, and that statement blocks on the rival's lock
  // whether or not the read locked — 1211ms unlocked vs 1219ms locked, the
  // same write-lock artefact in new clothing. With a live holder no `UPDATE`
  // is ever issued, so the read is the only statement that can touch the row
  // — 2ms unlocked vs a lock timeout locked. No seam, no test-only hook, and
  // no change to the shape of this function was needed after all.
  //
  // `OF a` restricts the lock to the assignment; the `ToolCall` and
  // `Session` sides are correlated reads, and locking them would contend
  // with telemetry ingest and with session re-registration for no benefit.
  //
  // The `Session` subquery yields NULL two ways that mean the same thing —
  // no row for that session id, or a row whose `hookVersion` is null — and
  // both are the fact condition 4 wants ("makes no claim about what the
  // session can enforce", SCHEMA.md §21). There is deliberately no join
  // here: `Session` has no foreign key from `Assignment` (a ghost session
  // holds claims without ever registering), so an inner join would silently
  // drop exactly those holders from the pass and a left join would say the
  // same thing as this at more width.
  const rows = await db.$queryRawUnsafe<HolderRow[]>(
    `SELECT a."id", a."itemId", a."role"::text AS "role", a."holderType", a."holderId",
            a."sessionId", a."liveness", a."releasedAt", a."lastActive", a."claimedAt",
            (SELECT MAX(t."ts") FROM "ToolCall" t WHERE t."sessionId" = a."sessionId")
              AS "lastToolCallAt",
            (SELECT s."hookVersion" FROM "Session" s WHERE s."id" = a."sessionId")
              AS "holderHookVersion"
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
      holderHookVersion: row.holderHookVersion,
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
        `this item.` +
        (judgement.declaredHookNeverSignalled
          ? ` NOTE: that session registered hook version ${row.holderHookVersion} but has ` +
            `emitted no signal at all since claiming — no heartbeat, and no tool call ever. ` +
            `A hook reports every tool call, so a registration naming one and then producing ` +
            `nothing is a session whose hook is not actually running (commonly an ` +
            `unprovisioned machine: the hook fails open, so nothing else reports this). Its ` +
            `silence was therefore never evidence about whether it was alive, and this ` +
            `eviction may have taken the claim from a working session. Treat the registration ` +
            `as the defect.`
          : ""),
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
