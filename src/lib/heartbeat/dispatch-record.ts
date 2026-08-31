// The dispatch ledger, and reading a failed launch out of it —
// MILESTONES.md #60 and #62, SCHEMA.md §14 ("Dispatch — an event, not a
// table").
//
// ── Two appends, not one mutable row ────────────────────────────────────
//
// A dispatch looks like it wants a table, because `session_id` arrives
// later than everything else — and a row that gains a column after the fact
// is a mutation, which an append-only ledger cannot hold. §14 resolves it by
// splitting the fact in two:
//
//   > - **`dispatch`** — `{machine, account_id, estimated_cost}`,
//   >   server-composed prompt in `body`
//   > - **`dispatch-claimed`** — `{dispatch_event_id, session_id}`, written
//   >   when a session first reports in
//
// Two appends, no mutation, ledger intact. The cost is that "did this launch
// work?" becomes a join rather than a null check — accepted explicitly,
// because it "runs every five minutes over recent events, not on a hot
// path".
//
// **The `dispatches` log is the reason any of this is recorded at all.** §5:
// "Kept instead: a `dispatches` **log**, so a launcher that silently fails
// is detectable — otherwise 'never launched' and 'never dispatched' are
// indistinguishable." That sentence is the whole justification for #62: a
// machine whose scheduled task quietly stopped firing looks, from the
// board, exactly like a server that never had work to send.
//
// ── This module is pure, and the reason matters ─────────────────────────
//
// Nothing here opens a transaction or touches Prisma. Building the payloads
// and deciding which dispatches failed are both decisions; writing rows is
// plumbing. Keeping the decisions pure means the failed-launch rule — the
// part with a clock in it and therefore the part most likely to be subtly
// wrong — is testable by passing a number, with no database, no fake timers
// and no waiting.
//
// The clock is a parameter for exactly that reason. A `Date.now()` inside
// the threshold comparison would make "claimed one millisecond before the
// threshold" a test that cannot be written.

/** The payload of a `dispatch` event — SCHEMA.md §3, the `dispatch` row. */
export interface DispatchPayload {
  readonly machine: string;
  readonly account_id: string;
  /**
   * The estimate this dispatch was planned against.
   *
   * Recorded because the plan that produced it is not stored anywhere — the
   * list *is* the allocation and it is discarded once handed out. Without
   * this, "what did the server think this would cost?" is unanswerable
   * after the fact, and the estimator can never be graded against outcomes.
   *
   * Snake-cased to match the payload key SCHEMA.md §3 names, which is the
   * shape already in the ledger and read by the import path.
   */
  readonly estimated_cost: number;
}

/** The payload of a `dispatch_claimed` event — SCHEMA.md §3. */
export interface DispatchClaimedPayload {
  /** The `dispatch` event this claims. The join key, so it is required. */
  readonly dispatch_event_id: string;
  readonly session_id: string;
}

/** Everything needed to append one `dispatch` event. */
export interface DispatchRecord {
  readonly itemId: string;
  readonly payload: DispatchPayload;
  /**
   * The server-composed prompt.
   *
   * In `body` rather than in the payload, per §14. `body` is the column for
   * prose the system did not generate a shape for, and a multi-paragraph
   * prompt inside a JSON payload would be read by every consumer that only
   * wanted the machine name.
   */
  readonly body: string;
}

/**
 * Builds the `dispatch` event for one planned dispatch.
 *
 * Separated from the append so that the payload shape has one definition
 * and one test, rather than being assembled inline at the call site where
 * a typo in `account_id` would be a silently-wrong payload — the exact
 * failure mode §3 gives for why the event `type` is an enum.
 */
export function buildDispatchRecord(input: {
  readonly itemId: string;
  readonly machine: string;
  readonly accountId: string;
  readonly estimatedCost: number;
  readonly prompt: string;
}): DispatchRecord {
  return {
    itemId: input.itemId,
    payload: {
      machine: input.machine,
      account_id: input.accountId,
      estimated_cost: input.estimatedCost,
    },
    body: input.prompt,
  };
}

/** Builds the `dispatch_claimed` payload written when a session reports in. */
export function buildDispatchClaimedPayload(input: {
  readonly dispatchEventId: string;
  readonly sessionId: string;
}): DispatchClaimedPayload {
  return {
    dispatch_event_id: input.dispatchEventId,
    session_id: input.sessionId,
  };
}

// ── #62: failed-launch detection ────────────────────────────────────────

/**
 * One `dispatch` event, as far as failure detection is concerned.
 *
 * `at` is milliseconds since the epoch rather than a `Date`, so the
 * comparison is arithmetic with nothing to go wrong across time zones.
 */
export interface DispatchObservation {
  readonly eventId: string;
  readonly itemId: string;
  readonly at: number;
}

export interface FailedLaunchInput {
  /** Recent `dispatch` events. */
  readonly dispatches: readonly DispatchObservation[];
  /**
   * The `dispatch_event_id` of every `dispatch_claimed` seen.
   *
   * A set of ids rather than the full events: whether a dispatch was
   * claimed is the only question, and *when* it was claimed does not
   * change the answer. A dispatch claimed late is claimed — the launcher
   * worked, which is the thing being tested.
   */
  readonly claimedDispatchEventIds: ReadonlySet<string>;
  /** Now, in milliseconds since the epoch. A parameter — see the module note. */
  readonly now: number;
  /**
   * `dispatch.failed_after_seconds` (SCHEMA.md §17, default 180).
   *
   * Taken as a parameter rather than read here, because a setting read is
   * I/O and this function is pure.
   */
  readonly failedAfterSeconds: number;
}

/**
 * Finds the launches that failed: **dispatched, never claimed, and past the
 * threshold** — all three, which is the spec.
 *
 * The third condition is what stops the check being nonsense. Every
 * dispatch is unclaimed for the moment between the server writing it and
 * the machine starting up; without the elapsed test, this would report
 * every dispatch it had just written as a failure, and the alarm would be
 * permanently on.
 *
 * Ordering is by event id so the answer is deterministic for the same
 * reason the planner's is — this feeds escalation, and an escalation that
 * names its subjects in a different order each run is one nobody can
 * deduplicate.
 */
export function findFailedLaunches(input: FailedLaunchInput): readonly DispatchObservation[] {
  const thresholdMs = input.failedAfterSeconds * 1000;

  return input.dispatches
    .filter((dispatch) => {
      if (input.claimedDispatchEventIds.has(dispatch.eventId)) return false;
      // Strictly greater than: a dispatch exactly on the threshold has not
      // yet been unclaimed for *longer* than the allowance, and the setting
      // reads as "no session against a dispatch after this long". One fixed
      // rule at the boundary, either way, is what matters — but the
      // generous reading is the right one for a check whose false positive
      // wakes a person.
      return input.now - dispatch.at > thresholdMs;
    })
    .slice()
    .sort((a, b) => (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0));
}
