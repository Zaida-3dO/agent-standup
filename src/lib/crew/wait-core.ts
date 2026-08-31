// Wait-for-crew, the part both implementations share — MILESTONES.md #64,
// DECISIONS.md §6, SCHEMA.md §19.
//
// ── Why there is a "core" at all ────────────────────────────────────────
//
// #64 asks for two implementations — a held-open endpoint and a polling
// one — *"both bounded by the visibility horizon and returning
// identically"*. Two implementations that must return identically is a
// statement about where the *decision* lives: if each door computed its own
// answer, "identical" would be a coincidence maintained by hand, and the
// first change to one would silently break it.
//
// So neither door computes anything. `crewSlice` below is the only thing
// that reads the ledger and decides what a wait returns; the doors differ
// only in **how they wait**, never in **what they answer**. That is what
// makes the identity assertion in the tests a real property rather than two
// parallel code paths that happen to agree.
//
// ── The bound, and why it is not the cursor alone ──────────────────────
//
// `readSinceBounded` (@/lib/events) reads `id > since AND txId < horizon`.
// SCHEMA.md §3 works through why the second half is required and §19 repeats
// it for this endpoint specifically: `events.id` is allocated at INSERT and
// becomes visible at COMMIT, so two transactions can commit out of order and
// a reader ordering by `id` alone steps over the late one permanently. For a
// wait that is not a cosmetic glitch — the event stepped over is a crew
// event, and missing it is the supervision gap this feature exists to close.
//
// This module therefore does not re-solve the cursor. It calls the read that
// is already proven and already bounded.
//
// ── The open decision this deliberately does NOT settle ────────────────
//
// MILESTONES.md lists under "Decisions blocking specific PRs": *"Does Codex
// need the blocking wait-for-crew fallback?"* — unanswered at the time of
// writing.
//
// Nothing here answers it, and the shape is chosen so that nothing has to.
// DECISIONS.md §6 already frames it as *"Same endpoint, two doors"*: the
// backgrounded CLI wait is the primary door, and a blocking variant is
// described there as *"a genuine fallback, not defensive"* for a client with
// no way to background a call. Both doors are built here; which clients are
// offered which is a binding-level and configuration-level choice that
// touches none of this code.
//
// Concretely, whichever way the decision goes:
//   - **Yes, Codex needs it** — the blocking door is already built and
//     already returns identically; it is exposed to that adapter.
//   - **No, it does not** — that door simply has no caller. No behaviour
//     here changes, and nothing has to be unpicked.
//
// **The implementation follows the binding, never the caller** (#64's own
// words). A caller does not get to ask for "the polling one"; it asks to
// wait, and the binding it is talking through determines how that is served.
// `waitForCrew` therefore takes its waiting strategy as a parameter rather
// than reading a flag out of the caller's input.
import { readSinceBounded, type SlimEventRow } from "@/lib/events";
import type { TransactionHandle } from "@/lib/service/context";

/**
 * The event types that count as *crew activity* for a wait.
 *
 * **Named explicitly rather than "anything on the ledger".** A wait exists
 * so an orchestrator learns that its crew did something worth looking at
 * (DECISIONS.md §6), and the ledger also carries rows that are not that —
 * a settings change, a field edit made by a person in the UI. Returning on
 * those would wake an orchestrator to tell it nothing, which costs a turn
 * and, at the cadence a wait runs, is the difference between supervision
 * and noise.
 *
 * `field_change` is deliberately excluded and `state_change` deliberately
 * included: an item moving state is a crew member finishing something, an
 * edited field usually is not.
 */
export const CREW_EVENT_TYPES = [
  "claim",
  "release",
  "takeover",
  "state_change",
  "checkpoint",
  "note",
  "review_requested",
  "review",
  "merge",
  "escalation",
  "nudge",
  "open_loop",
  "open_loop_closed",
] as const;

export type CrewEventType = (typeof CREW_EVENT_TYPES)[number];

const CREW_EVENT_SET: ReadonlySet<string> = new Set(CREW_EVENT_TYPES);

/** Whether one ledger row is something a waiting orchestrator should be woken for. */
export function isCrewEvent(type: string): boolean {
  return CREW_EVENT_SET.has(type);
}

/**
 * What a wait returns — **the same shape from both doors, by construction**.
 *
 * `cursor` is always present, including on a timeout, because a caller that
 * timed out must be able to ask again from where it got to. Handing back
 * the cursor it sent would be correct but wasteful; handing back nothing
 * would make it re-read from the beginning.
 *
 * `horizon` is exposed for the reason `readSinceBounded` returns it:
 * a caller or a monitor can compare it against the clock and tell a healthy
 * short delay apart from a stuck long-running transaction holding rows back.
 */
export interface CrewSlice {
  readonly events: readonly SlimEventRow[];
  readonly cursor: string;
  readonly horizon: string;
  /** True when the wait ended because its bound elapsed rather than because events arrived. */
  readonly timedOut: boolean;
}

/**
 * One read of the ledger, filtered to crew activity.
 *
 * **The single place a wait's answer is computed.** Both doors call this and
 * neither adds to it, which is what makes "returning identically" a property
 * of the code rather than of two implementations being kept in step.
 *
 * The cursor returned is the high-water mark of rows **below the horizon**,
 * taken from the read itself. Notice it advances past events that were
 * filtered out: a non-crew row still moves the cursor, because it has been
 * seen and re-reading it would return it forever. Filtering decides what a
 * caller is *woken for*, never what it has *read*.
 */
export async function crewSlice(
  db: TransactionHandle,
  since: bigint,
  limit?: number,
): Promise<Omit<CrewSlice, "timedOut">> {
  const { events, horizon } = await readSinceBounded(db, { since, limit });
  const highWater = events.reduce((max, row) => (row.id > max ? row.id : max), since);
  return {
    events: events.filter((row) => isCrewEvent(row.type)),
    cursor: highWater.toString(),
    horizon: horizon.toString(),
  };
}

/**
 * How long a wait may be held open, in milliseconds.
 *
 * Clamped to `crew.wait_timeout_seconds` (SCHEMA.md §17: *"How long a
 * wait-for-crew call is held before returning empty. Sized to stay inside
 * the shortest prompt-cache lifetime a session may be given"*). §19 says
 * `timeout` **is clamped** to that setting, so a caller asking for longer
 * gets the configured maximum rather than a refusal — the request is
 * satisfiable, just not on the caller's terms, and refusing it would make
 * every client carry a copy of the server's configuration to avoid.
 *
 * A caller asking for *less* is honoured. That is not a loophole: a shorter
 * wait costs the server nothing and is exactly what a client with its own
 * tighter deadline should be able to ask for.
 */
export function clampWaitMs(requestedSeconds: number | undefined, maxSeconds: number): number {
  if (requestedSeconds === undefined) return maxSeconds * 1_000;
  const bounded = Math.min(requestedSeconds, maxSeconds);
  // A zero or negative request becomes a single immediate read rather than
  // an error or an unbounded wait — "check now and tell me" is a coherent
  // thing to ask for, and it is what a polling client does on its first
  // call.
  return Math.max(bounded, 0) * 1_000;
}

/**
 * The clock and the sleep, injected.
 *
 * Real timers make a timeout test either slow or flaky, and a wait's whole
 * contract is about *when* it returns. With these as parameters the tests
 * drive a virtual clock and assert the boundary exactly — a wait satisfied
 * one tick before the horizon, and one that times out exactly at it.
 */
export interface WaitClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The real one. */
export const systemClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * How a door waits between reads.
 *
 * This is the *only* axis on which the two implementations differ, and it
 * is a strategy rather than a branch so that neither door can drift into
 * answering differently:
 *
 *   - **`poll`** — sleep `crew.wait_poll_interval_seconds` and read again.
 *     Used where nothing can hold a connection open.
 *   - **`hold`** — wait to be signalled that the ledger moved, with the
 *     remaining budget as a ceiling. Used by the held-open endpoint.
 *
 * Both are bounded by the same deadline and both return through
 * `crewSlice`, so the answer cannot differ; only the latency and the
 * number of reads do.
 */
export interface WaitStrategy {
  /**
   * Waits for up to `budgetMs`, resolving early if the strategy has reason
   * to believe there is something to read. Resolving early is always safe:
   * the caller re-reads and, finding nothing, waits again within the same
   * deadline. A strategy is therefore allowed to be imprecise, and a
   * spurious wake costs one bounded read.
   */
  pause(budgetMs: number, clock: WaitClock): Promise<void>;
}

/** The polling door's strategy: fixed-interval sleep, never overrunning the deadline. */
export function pollingStrategy(intervalSeconds: number): WaitStrategy {
  return {
    async pause(budgetMs, clock) {
      // Never sleep past the deadline — that is what would make the polling
      // door return later than the held-open one and break the identity.
      await clock.sleep(Math.min(intervalSeconds * 1_000, budgetMs));
    },
  };
}

/**
 * The held-open door's strategy: wait for a signal, with the deadline as a
 * ceiling.
 *
 * `signal` resolves when something suggests the ledger has moved. A signal
 * that never fires degrades this into a single full-length wait, which is
 * still correct — it returns empty at the timeout, exactly as the polling
 * door would.
 */
export function holdingStrategy(signal: () => Promise<void>): WaitStrategy {
  return {
    async pause(budgetMs, clock) {
      await Promise.race([signal(), clock.sleep(budgetMs)]);
    },
  };
}

/**
 * Wait for crew activity, and return the first slice that has any — or
 * empty at the deadline.
 *
 * **Identical from both doors, and that is the tested property.** The loop,
 * the bound, the filter and the returned shape are all here; `strategy`
 * contributes only the pause between reads. Two waits started from the same
 * cursor against the same ledger return equal `CrewSlice`s whichever
 * strategy they were given, differing at most in how long they took.
 *
 * The first read happens **before** any pause, so a wait started when
 * events are already outstanding returns immediately rather than sleeping
 * first. A client that has just been handed a cursor and asks again is the
 * common case, not the exception.
 */
export async function waitForCrew(
  db: TransactionHandle,
  args: {
    readonly since: bigint;
    readonly budgetMs: number;
    readonly strategy: WaitStrategy;
    readonly clock?: WaitClock;
    readonly limit?: number;
  },
): Promise<CrewSlice> {
  const clock = args.clock ?? systemClock;
  const deadline = clock.now() + args.budgetMs;
  let since = args.since;

  for (;;) {
    const slice = await crewSlice(db, since, args.limit);
    if (slice.events.length > 0) return { ...slice, timedOut: false };

    // The cursor advances even with nothing to report, so a ledger busy
    // with non-crew events does not make every pass re-read the same rows.
    since = BigInt(slice.cursor);

    const before = clock.now();
    const remaining = deadline - before;
    // `<= 0` is the deadline itself, not past it: a wait whose budget has
    // exactly run out has finished waiting. This is the boundary the
    // "times out exactly at the deadline" test pins.
    if (remaining <= 0) return { ...slice, timedOut: true };

    await args.strategy.pause(remaining, clock);

    // ── Termination does not rest on the comparison above alone ─────────
    //
    // **Found by mutation, and worth the four lines.** Changing `<= 0` to
    // `< 0` above does not make this loop return late — it makes it never
    // return at all: at exactly the deadline `remaining` is 0, a strategy
    // that clamps its sleep to the remaining budget then sleeps 0, the
    // clock does not move, and the loop spins forever. Under a real clock
    // it is a busy-loop pinning a core and holding a connection; under a
    // virtual one it hangs the process hard enough that the test runner
    // cannot even report which test was running.
    //
    // A wait is a bounded operation whose whole contract is that it ends,
    // so it should not be one mutated comparison away from unbounded. If a
    // pause did not advance the clock, the budget cannot be consumed by
    // waiting and looping again would repeat this pass identically —
    // so the wait is over.
    if (clock.now() <= before) return { ...slice, timedOut: true };
  }
}
