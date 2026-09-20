// The server-side producer for the stop catch's context — MILESTONES.md
// #47, DECISIONS.md §6.
//
// ── The gap this closes ────────────────────────────────────────────────
//
// `../hook/stop-catch.ts` was built, is correct, and has never once spoken.
// It reads a `stop` block off the hook response (`readStopContext`), and the
// server has never put one there: `hook_decision` returned early on a `Stop`
// event with `{decision, reason, canBlock, findings}` and nothing else. So
// `readStopContext` received `undefined` on every stop, `evaluateStopCatch`
// returned `null` on every stop, and a feature that looks built from either
// side alone was inert in the middle.
//
// This module is the missing half. It assembles the two facts §6's condition
// is stated in terms of, and nothing else.
//
// ── The condition, and why the silent half is the important one ─────────
//
//   > Condition is *"crew running AND nothing scheduled to wake you"* —
//   > silent if a wait is already backgrounded, or you'd nag every turn.
//
// An orchestrator that has already backgrounded a wait has done exactly the
// right thing. Telling it so anyway is how an advisory channel gets
// filtered out, and once filtered it is gone for the case that mattered. So
// the wake half is not a refinement of the crew half — it is the half that
// decides whether this feature is worth having, and it is tested harder
// than the firing case for that reason.
//
// ── Advisory, and structurally so ──────────────────────────────────────
//
// This produces a value with no verdict in it. `StopContextPayload` carries
// counts and flags; there is no field on it that could refuse a stop, and
// the operation that sends it returns `decision: "allow"` on the `Stop`
// branch unconditionally. A blocked Stop traps an agent in a loop (§6), and
// the staleness ladder is already the backstop, so nothing here is given a
// channel it could block through even by mistake.
//
// ── `unfinishedWork`, and the narrowing that made it answerable ────────
//
// `StopContext` has an `unfinishedWork` count for the owner's second ask —
// *"the agent shouldn't just stop if there is still work remaining"* — and
// this producer supplies it from a **session-scoped** question, not from
// the board-wide one. The distinction is the whole of why the field can be
// filled honestly at all, so it is worth stating before the query.
//
// **What is not buildable here.** `./builtins.ts` lists **I2** as unbuildable
// because *whether a row is unblocked* has no answer in this schema. The
// dependency graph that would decide it is prose in a milestone document
// rather than a relation between items, and `Item.blockedOnType` admits
// `person`, `external_process` and `time` with no `item` member — so one
// row cannot even be recorded as waiting on another. **This module does not
// pretend otherwise:** nothing here asks the graph anything.
//
// **Why the cheap substitute is rejected.** I2 also records that version
// being turned down: treating an item with no open children
// as unblocked *"would fire on every leaf in the backlog, which is most of
// the board."* That objection is about **scope**, not about the word
// `blocked` — a count ranging over the backlog points at work nobody
// expected this session to finish, and a message that fires when there is
// nothing to do is the one that gets ignored when there is.
//
// **The narrowing.** This count never ranges over the backlog. It ranges
// over the rows *this session itself put on the board or took hold of* —
// see `UNFINISHED_WORK_QUERY` below for the three-way scope. A session that
// minted a row and walked away from it is not being told about the backlog;
// it is being told about a thing it did, in this session, and left. That is
// a fact the ledger records directly (`Event.sessionId` on the creation
// `field_change`), not an inference from a graph that does not exist.
//
// So, stated plainly: I2's question is unanswerable and is not asked here. A
// different, smaller question — *did you leave your own work open?* — is
// asked instead, and it has an answer.

import type { TransactionHandle } from "@/lib/service/context";
import { isCrewWaitCommand } from "./commands";

/**
 * The `stop` block, exactly as the hook's `readStopContext` parses it.
 *
 * **The field names are a wire contract, not a local choice.** The client
 * validates each one independently and drops anything it does not
 * recognise, so a near-miss on a name is indistinguishable from sending
 * nothing at all — the reader would see a silent catch and no error. Every
 * name here matches `StopContext` in `../hook/stop-catch.ts`; the shape is
 * restated rather than imported because this module sits on the service
 * side of the boundary and produces a serialisable payload, the same
 * posture `InterventionContext` takes.
 *
 * `unfinishedWork` is session-scoped — see the module header.
 */
export interface StopContextPayload {
  /** How many crew under this session's root are still running. */
  readonly liveCrew: number;
  /** Whether something is already lined up to wake this session. */
  readonly wakeScheduled: boolean;
  /**
   * How many of **this session's own** rows are still open and not blocked.
   *
   * Absent when the count could not be established, never zero-as-unknown:
   * the client reads absent as "nobody counted" and stays silent, and a
   * manufactured zero would be a settled claim this module had not earned.
   * Zero is sent when it is genuinely zero, which is the clean stop.
   */
  readonly unfinishedWork?: number;
}

/**
 * How recently a `wait_for_crew` call counts as a wait that is still
 * running.
 *
 * ── Why a window rather than a stored flag ─────────────────────────────
 *
 * Nothing records "this session has a backgrounded wait". `wait_for_crew` is
 * a read operation that blocks and returns; it writes no row saying it is in
 * progress, and adding one would mean a write on a read path plus a way to
 * clear it when the shell process dies — which is a durability problem for a
 * fact that is only ever a few minutes old.
 *
 * What it does leave is a `ToolCall` row at the moment it was invoked. A
 * session that called it recently is a session that backgrounded a wait, and
 * "recently" is the honest form of that inference.
 *
 * ── Why this bound, and which way it errs ──────────────────────────────
 *
 * The window must cover a wait's whole life, because the catch has to stay
 * silent for as long as the wait is actually running. `crew.wait_timeout`'s
 * configured maximum is what bounds that life, so the window is derived from
 * the same setting rather than picked — a wait cannot outlive its own
 * timeout, so a window of one timeout plus a margin covers every wait that
 * could still be in flight.
 *
 * The margin exists because the two clocks are not the same: the wait's
 * timeout is measured by the shell process, and this window is measured
 * against a `ToolCall` timestamp written when the call *started*. Scheduling
 * and round-trip put the two a little apart, and the asymmetry of the errors
 * decides which way to round. Too short, and the catch nags an orchestrator
 * that is waiting correctly — the precise false positive §6 forbids. Too
 * long, and a stop shortly after a wait expired goes unremarked, which costs
 * one missed reminder on the next stop. So it rounds generous.
 */
const WAIT_WINDOW_MARGIN_SECONDS = 60;

/**
 * How many recent shell calls are examined for a backgrounded wait.
 *
 * The wait check reads `command` text, which cannot be matched in SQL
 * without embedding the recogniser in a `LIKE` that would immediately drift
 * from `isCrewWaitCommand`. So the rows come back and the shared recogniser
 * judges them in this process — the same arrangement `occupancyFor` uses for
 * worktree comparison, and for the same reason: one definition, applied in
 * one language.
 *
 * A bound rather than an unbounded read because this runs on a `Stop`. The
 * window is already narrow (one wait timeout), and a session that made
 * hundreds of shell calls inside it is one whose wait, if any, is among the
 * most recent — ordering by time and stopping at this bound cannot miss a
 * wait that is still running unless the session made this many shell calls
 * since launching it, at which point it is plainly not idle.
 */
const SHELL_CALL_LIMIT = 200;

/** The one row shape the crew half reads. */
interface StopRow {
  /** Crew under this root still genuinely running, excluding this session. */
  liveCrew: number;
}

/** The one row shape the unfinished-work half reads. */
interface UnfinishedRow {
  /** This session's own rows that are still open and not blocked. */
  unfinished: number;
}

/**
 * The states that mean a row is **not** finished and **not** parked.
 *
 * Spelled as an explicit allow-list rather than "everything except the
 * terminal ones", and the difference decides whether this nudge survives
 * contact. `ItemState` has twelve members; a future thirteenth added for
 * some parked or waiting condition would be silently counted as unfinished
 * by a deny-list, and the entry would start firing on rows nobody could act
 * on — the exact failure this narrowing exists to avoid. An allow-list makes
 * a new state silent by default, which is the safe direction: a missed
 * reminder costs one stop, a false one costs the channel.
 *
 * Four states are deliberately **absent** and each for its own reason:
 *
 *   - `blocked` — the row says outright that it is waiting on something.
 *     Counting it would be telling a session to do work it has recorded as
 *     undoable, which is the first thing that would make this noise.
 *   - `paused` — a deliberate decision to stop, with a `resumeCondition`.
 *     Same argument as `blocked`: a considered park is not an oversight.
 *   - `someday` — explicitly not now. A backlog marker by definition.
 *   - `in_review` / `plan_review` — the work is done and the ball is with a
 *     reviewer. A session that finished and handed off has finished.
 *
 * `merged`, `research_done`, `wont_do` and `cancelled` are terminal and
 * excluded for the obvious reason.
 */
const UNFINISHED_STATES = ["on_deck", "planning", "executing"] as const;

/**
 * This session's own unfinished rows.
 *
 * ── The three-way scope, which is the whole design ─────────────────────
 *
 * I2 rejected counting unfinished work because a backlog-wide count *"would
 * fire on every leaf in the backlog, which is most of the board"*. Every
 * clause here exists to keep that from being true of this count. A row is
 * counted only when this session is responsible for it, in one of three
 * ways the ledger records directly:
 *
 *   1. **This session minted it.** A create appends a `field_change` with
 *      `{field: "state", from: null}` carrying the creating `sessionId`
 *      (`../service/items/create-core.ts` — through `appendEvent`
 *      precisely so the session lands on the row). This is the item body's
 *      strongest signal: *"the session found the work, filed it, and walked
 *      away from it."*
 *   2. **This session holds a live claim on it.** An unreleased
 *      `Assignment` is an open statement that this session is the one
 *      working the row.
 *   3. **This session released a claim on it** while leaving it open — the
 *      case that would otherwise slip through, because dropping a claim is
 *      the easiest way to stop owning something without finishing it.
 *
 * A row nobody in this session ever touched is not counted, whatever state
 * it is in. That is what makes the number mean *"work you left"* rather
 * than *"work that exists"*.
 *
 * ── Why archived rows are excluded ─────────────────────────────────────
 *
 * `archivedAt` marks a row withdrawn from circulation — a duplicate or an
 * accident, served by no ordinary read. Counting one would point a session
 * at a row it is not meant to see on any other surface.
 *
 * ── Why projects are excluded, which a unit test could not have told us ─
 *
 * A `project` is a container: its state tracks the work underneath it
 * rather than describing a unit of work anybody performs. Minting a task
 * usually means minting or touching the project above it, so counting both
 * reports two unfinished things where the session did one — and the count
 * is quoted verbatim in the message, so an inflated number is a message
 * that is simply wrong.
 *
 * **This was found by running the query, not by reading it.** The unit
 * suite's canned handle cannot surface it: it answers whatever row the test
 * supplies, so the double count only appears once a real `create_task` has
 * written a real project row beside the task. `tests/interventions-stop-
 * unfinished-db.test.ts` failed on exactly this, by exactly one, on every
 * case that minted anything.
 */
const UNFINISHED_WORK_QUERY = `
  SELECT COUNT(DISTINCT i."id")::int AS "unfinished"
    FROM "Item" i
   WHERE i."state" = ANY($2::text[]::"ItemState"[])
     AND i."kind" <> 'project'
     AND i."archivedAt" IS NULL
     AND (
           EXISTS (SELECT 1
                     FROM "Event" e
                    WHERE e."itemId" = i."id"
                      AND e."sessionId" = $1
                      AND e."type" = 'field_change'
                      AND e."payload"->>'field' = 'state'
                      AND e."payload"->>'from' IS NULL)
        OR EXISTS (SELECT 1
                     FROM "Assignment" a
                    WHERE a."itemId" = i."id"
                      AND a."sessionId" = $1)
         )`;

/**
 * Assembles the `stop` block for one `Stop` event, or `undefined` when there
 * is nothing to say.
 *
 * ── Why `undefined` rather than a zeroed block ─────────────────────────
 *
 * A session with no live claim has no crew to be waiting on, and there is no
 * root to count under. Returning `{liveCrew: 0, wakeScheduled: false}` would
 * be a claim about a crew that was never looked for; returning nothing is
 * the same absent-means-unknown discipline `assembleContext` applies to
 * every optional field it cannot honestly answer. The client handles an
 * absent block correctly by design — `readStopContext` answers `undefined`
 * and both catches return `null`.
 *
 * ── Why the liveness test is the Fleet page's ──────────────────────────
 *
 * `Assignment.liveness` is a stored column only the sweep advances, so alone
 * it reports the last sweep's verdict — the defect #400 fixed on the Fleet
 * page, where claims gone for days still counted as "Running". The count
 * here therefore requires the row to say `running` **and** its `lastActive`
 * to be inside the dead threshold, which is what `bandOf` now asks. This is
 * the same query `crewInFlightFor` makes, for the same reason: one notion of
 * "crew are running", not a third.
 */
export async function assembleStopContext(options: {
  readonly db: TransactionHandle;
  readonly sessionId: string;
  /** `liveness.dead_after_seconds` — the liveness bound, handed in. */
  readonly deadAfterSeconds: number;
  /** `crew.wait_timeout_max_seconds` — what bounds a wait's life. */
  readonly waitTimeoutMaxSeconds: number;
}): Promise<StopContextPayload | undefined> {
  const { db, sessionId, deadAfterSeconds, waitTimeoutMaxSeconds } = options;

  const waitWindowSeconds = waitTimeoutMaxSeconds + WAIT_WINDOW_MARGIN_SECONDS;

  // The crew count is scoped to the **root** of this session's own claim, so
  // a session that holds nothing counts nothing: the subquery yields no row,
  // the comparison fails, and the count is zero rather than the whole board.
  const rows = await db.$queryRawUnsafe<StopRow[]>(
    `SELECT COUNT(DISTINCT a."sessionId")::int AS "liveCrew"
       FROM "Assignment" a
      WHERE a."rootSessionId" = (
              SELECT own."rootSessionId"
                FROM "Assignment" own
               WHERE own."sessionId" = $1 AND own."releasedAt" IS NULL
               ORDER BY own."claimedAt" DESC
               LIMIT 1)
        AND a."sessionId" <> $1
        AND a."releasedAt" IS NULL
        AND a."liveness" = 'running'
        AND a."lastActive" > NOW() - MAKE_INTERVAL(secs => $2)`,
    sessionId,
    deadAfterSeconds,
  );

  const row = rows[0];
  // No row means the query did not answer, which is "not known" rather than
  // "no crew" — and an unknown must not be rendered as a block claiming zero
  // crew and no wake, because the client would read that as a settled fact.
  if (row === undefined) return undefined;

  // The wait half. Read as rows and judged here rather than matched in SQL,
  // so that `isCrewWaitCommand` is the single definition of what a wait
  // invocation looks like — a `LIKE` here would be a second one, and the two
  // would drift the first time the command grew an alias.
  const shellCalls = await db.$queryRawUnsafe<{ command: string | null }[]>(
    `SELECT t."command" AS "command"
       FROM "ToolCall" t
      WHERE t."sessionId" = $1
        AND t."command" IS NOT NULL
        AND t."ts" > NOW() - MAKE_INTERVAL(secs => $2)
      ORDER BY t."ts" DESC
      LIMIT $3`,
    sessionId,
    waitWindowSeconds,
    SHELL_CALL_LIMIT,
  );

  const wakeScheduled = shellCalls.some(
    (call) => call.command !== null && isCrewWaitCommand(call.command),
  );

  // The unfinished-work half. Read unconditionally rather than skipped when
  // crew are running: `evaluateStopCatch` decides which catch speaks, and a
  // producer that withheld the count whenever crew were live would be
  // making that choice a second time, in a second place. One definition of
  // the precedence, on the side that already has it.
  //
  // A missing row is left **absent** rather than zeroed, the same discipline
  // the crew half applies: a query that did not answer is "not known", and
  // the client is built to stay silent on an absent count. A zero here would
  // assert a clean stop this module had not established.
  const unfinishedRows = await db.$queryRawUnsafe<UnfinishedRow[]>(
    UNFINISHED_WORK_QUERY,
    sessionId,
    [...UNFINISHED_STATES],
  );
  const unfinished = unfinishedRows[0]?.unfinished;

  return {
    liveCrew: row.liveCrew,
    wakeScheduled,
    ...(unfinished === undefined ? {} : { unfinishedWork: unfinished }),
  };
}
