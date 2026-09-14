// `wait_for_crew` — the operation that makes MILESTONES.md #64's wait
// reachable. SCHEMA.md §18 ("Not exposed as MCP: `wait_for_crew`. It's
// `standup crew wait` (§20), because only a shell call can be backgrounded"),
// §19 (`GET /crew/wait?since=&timeout=`), DECISIONS.md §6.
//
// ── Why this file is thin, and has to be ───────────────────────────────
//
// `@/lib/crew/wait-core` already holds every decision a wait makes: what
// counts as crew activity, how the cursor advances, where the horizon bound
// comes from, and when the loop ends. That module's header explains at
// length why those live in one place — "two implementations that must
// return identically is a statement about where the *decision* lives".
//
// This operation therefore computes nothing. It resolves configuration,
// picks a waiting strategy, and calls `waitForCrew`. Anything more here
// would be a second place a wait's answer is decided, which is the exact
// property the core was built to prevent.
//
// ── Why the strategy is `poll` and not `hold` ──────────────────────────
//
// `wait-core` offers two doors, and the choice between them is the binding's
// to make, never the caller's ("the implementation follows the binding, never
// the caller" — #64). The doors this operation is reached through are the
// HTTP route and the command line, and neither has a signal to hold on:
//
//   - `holdingStrategy` needs a `signal()` that resolves when the ledger
//     moves. Nothing in this application publishes one — there is no
//     listener, no `NOTIFY`, no in-process event bus a request handler could
//     subscribe to. Passing a signal that never fires would degrade the hold
//     into a single full-length sleep that reads the ledger exactly twice,
//     which is strictly worse than polling: it would miss events that
//     arrived mid-wait and return empty at the deadline with them sitting
//     unread.
//   - `pollingStrategy` re-reads on the interval the installation already
//     configures for exactly this (`crew.wait_poll_interval_seconds`, whose
//     own help text says "used only where no long-poll is available").
//
// So the polling door is not a placeholder for a better one — it is the
// correct door for a transport with nothing to be woken by. If a signal is
// ever published, `holdingStrategy` is already built and returns identically
// by construction; swapping it in here changes no answer, only the latency.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  clampWaitMs,
  pollingStrategy,
  systemClock,
  waitForCrew,
  type WaitClock,
} from "@/lib/crew/wait-core";
import type { SlimEventRow } from "@/lib/events";

/**
 * The row bound, matching `get_events`'s.
 *
 * A wait returns as soon as *anything* crew-shaped lands, so in practice it
 * comes back with a handful of rows rather than a page. The cap is here for
 * the case that is not the common one: a caller resuming from an old cursor
 * after a long absence, whose first read is a backlog rather than a trickle.
 * Without a bound that read is the whole ledger since `since`.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = z
  .object({
    /**
     * Exclusive lower bound on `id` — "everything after this".
     *
     * A string rather than a number, for the reason `get_events` gives for
     * the same field: `events.id` is a `bigint`, and past 2^53 a JSON number
     * silently loses precision. A cursor that quietly rounds is a cursor that
     * skips or repeats rows, and for a wait that means an orchestrator never
     * being told its crew moved.
     *
     * Required rather than defaulted to zero. §19 says `since` "is required
     * and is handed back by `claim`, `orientation` and every wait, so a
     * caller always has one" — and defaulting it would turn a caller that
     * forgot to thread its cursor into one that re-reads the ledger from the
     * beginning and returns instantly with ancient events, which looks like
     * a working wait and is not one.
     */
    since: z.string().regex(/^\d+$/, "since must be a non-negative integer"),
    /**
     * How long to wait, in seconds. **Clamped**, never refused.
     *
     * §19: "`timeout` is clamped to `crew.wait_timeout_seconds`". The clamp
     * lives in `clampWaitMs` in the core, which also documents why asking
     * for *less* is honoured: a shorter wait costs the server nothing and is
     * what a client with its own tighter deadline should be able to ask for.
     *
     * Omitted means "the configured maximum", which is what an orchestrator
     * backgrounding a wait wants and should not have to name.
     */
    timeout: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  })
  .strict();

export type WaitForCrewInput = z.infer<typeof inputSchema>;

/**
 * One crew event, in the slim shape.
 *
 * `payload` and `body` are deliberately absent and there is no `full` opt-in
 * to bring them back. A wait answers "did anything happen, and what kind" —
 * the caller that wants a checkpoint's text reads it with `get_item` or
 * `orientation`, which is one call it makes only when the wait returned
 * something. Carrying every body through every wait would put the two
 * unbounded columns on the response that is polled most often, which is the
 * measurement `get_events` records in `@/lib/events`: those columns were ~95%
 * of a realistic event.
 */
export interface CrewEvent {
  /** `bigint` stringified — `JSON.stringify` throws on a `bigint` outright. */
  readonly id: string;
  readonly txId: string;
  readonly itemId: string | null;
  readonly ts: string;
  readonly actorType: SlimEventRow["actorType"];
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly assignmentId: string | null;
  readonly type: SlimEventRow["type"];
}

export interface WaitForCrewOutput {
  readonly events: readonly CrewEvent[];
  /** The cursor to pass as `since` next time — always present, including on a timeout. */
  readonly cursor: string;
  /** SCHEMA.md §3's visibility horizon, so a caller can tell a short delay from a stuck one. */
  readonly horizon: string;
  /** True when the wait ended at its deadline rather than because events arrived. */
  readonly timedOut: boolean;
  /** How long the wait was actually bounded to, after clamping — so a caller can see the clamp happened. */
  readonly waitedForSeconds: number;
}

/**
 * The clock, injectable for tests only.
 *
 * Not part of the input schema — a caller cannot send a clock over HTTP or
 * the command line, and a wait whose clock came from its input would be a
 * wait a caller could make return instantly. The operation reads the real
 * one by default; the tests call the exported handler body with their own.
 */
export interface WaitForCrewDeps {
  readonly clock?: WaitClock;
}

/**
 * Runs one wait. Separated from the operation declaration so a test can
 * drive it with a virtual clock without going through the registry, and so
 * the operation below stays a declaration rather than a body.
 */
export async function runWaitForCrew(
  ctx: ServiceContext,
  input: WaitForCrewInput,
  deps: WaitForCrewDeps = {},
): Promise<WaitForCrewOutput> {
  // Both numbers come from the snapshot resolved for this call, never read
  // twice — `ServiceContext`'s own header explains why an operation cannot
  // ask for a second one.
  const maxSeconds = ctx.settings.values["crew.wait_timeout_seconds"];
  const intervalSeconds = ctx.settings.values["crew.wait_poll_interval_seconds"];

  const budgetMs = clampWaitMs(input.timeout, maxSeconds);

  const slice = await waitForCrew(ctx.db, {
    since: BigInt(input.since),
    budgetMs,
    strategy: pollingStrategy(intervalSeconds),
    clock: deps.clock ?? systemClock,
    limit: input.limit,
  });

  return {
    events: slice.events.map((event) => ({
      id: event.id.toString(),
      txId: event.txId.toString(),
      itemId: event.itemId,
      ts: event.ts.toISOString(),
      actorType: event.actorType,
      actorId: event.actorId,
      sessionId: event.sessionId,
      assignmentId: event.assignmentId,
      type: event.type,
    })),
    cursor: slice.cursor,
    horizon: slice.horizon,
    timedOut: slice.timedOut,
    // Reported in seconds because that is the unit the caller asked in and
    // the unit the setting is written in. It is the *clamped* figure, which
    // is the point: a caller that asked for an hour and got 240 seconds can
    // see that from the answer instead of inferring it from how long the
    // call took.
    waitedForSeconds: budgetMs / 1_000,
  };
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const waitForCrewOperation = defineOperation({
  name: "wait_for_crew",
  kind: "read",
  summary:
    "Wait for your crew to do something, and return the events when they do — or empty at the timeout. Pass since (the cursor claim, orientation and every wait hand back) and an optional timeout in seconds, clamped to the configured maximum. Background it from a shell: this is what `standup crew wait` calls.",
  // Stryker restore all
  input: inputSchema,
  handler: (ctx: ServiceContext, input: WaitForCrewInput) => runWaitForCrew(ctx, input),
});
