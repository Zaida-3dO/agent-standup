// The overnight report — "since 18:00 yesterday: N merged, N blocked, ~$X"
// — over the shapes that already exist rather than a parallel computation
// of its own. See this module's own limits, named plainly below, for what
// it could NOT source from an existing operation.
//
// ── What this consumes, and what it does not invent ─────────────────────
//
// **Merges and new blocks come from `get_events`** (`@/lib/since/types`,
// `GET /api/events`) — the same ledger `/activity` already renders, read
// here for a cutoff rather than a cursor. `get_events`'s own `since` is an
// event-id cursor, not a timestamp (`../service/operations/get-events.ts`'s
// own doc: "past 2^53 a JSON number silently loses precision" is why it is
// a bigint-shaped id, not a clock reading) — so this fetches the ledger's
// most recent bounded slice and filters by `ts` client-side rather than
// asking the server for a window it has no timestamp parameter to express.
// That is a real constraint worth naming: a cutoff more than `limit` events
// older than the read would silently under-report, because the slice would
// run out before reaching it. See `OvernightReport.truncated`.
//
// **Spend comes from `get_costs`** (`@/lib/costs/types`, `GET /api/costs`)
// — `since` there genuinely IS a timestamp (`../service/operations/
// get-costs.ts`'s `startedAt >=` bound), so the cutoff reaches it exactly.
//
// **What this could NOT source, stated plainly rather than fabricated:**
// there is no "agent died" EVENT in the ledger's vocabulary
// (`@/lib/since/types.ts`'s `SinceEventType` — no `dead`/`liveness_changed`
// entry) to count "died overnight" from. Liveness (`running` / `stalled` /
// `dead` / `superseded`) is a live-read computed over current assignments
// (`../service/items/assignment-view.ts`), not an appended event, so there
// is no "how many became dead between two points in time" to read. This
// report therefore shows **assignments that are dead or stalled as of this
// read** — a live snapshot passed in from the board read the Standup page
// already makes for "in flight now" — rather than an overnight delta, and
// says so in its own label. A caller wanting the true delta would need a
// new event type this task's brief does not ask for.
import type { SinceEvent } from "@/lib/since/types";
import type { CostsPayload } from "@/lib/costs/types";
import { totalCost } from "@/lib/costs/state";
import type { BoardAssignment } from "@/lib/board/types";

/** One line the report can show — a merge or an item newly blocked, in the reader's terms. */
export interface OvernightLine {
  readonly itemId: string | null;
  readonly itemTitle: string | null;
  readonly ts: string;
}

export interface OvernightReport {
  readonly since: string;
  readonly merged: readonly OvernightLine[];
  readonly newlyBlocked: readonly OvernightLine[];
  /**
   * How many assignments are dead or stalled as of this read — a live
   * count, not an overnight delta. See the module header for why the delta
   * is not available.
   */
  readonly deadOrStalledNow: number;
  /** Recomputed spend since the cutoff, or null when nothing in the window could be priced. */
  readonly cost: number | null;
  /**
   * True when the events slice this was built from may have run out before
   * reaching `since` — the merged/newlyBlocked counts are then a floor, not
   * the whole window. See the module header's note on the cursor-vs-cutoff
   * constraint.
   */
  readonly eventsTruncated: boolean;
}

/**
 * An event whose `state_change` payload moved the item TO `to`.
 *
 * Requires `event.payload` to be present, which means this report's own
 * events fetch must ask for `full: true` (see `fetchStandup` in
 * `state.ts`) — the slim default (`SinceEvent`'s own header) does not
 * carry `payload` at all, and an event missing it can never match here
 * rather than being misread as "not a state change".
 */
function movedTo(event: SinceEvent, to: string): boolean {
  return event.type === "state_change" && event.payload?.to === to;
}

/**
 * Builds the report from an events slice already fetched for this cutoff,
 * plus a costs payload already fetched with `since` set to the same cutoff.
 *
 * A pure function over data the caller assembled — this module makes no
 * fetch calls of its own, matching `@/lib/board/view.ts` and
 * `@/lib/since/view.ts`'s split between fetching and deriving.
 *
 * `requestedLimit` is the `limit` the caller passed to `GET /api/events` to
 * produce `events` — needed to tell "the slice came back short of the page
 * size, so it reached the ledger's start" from "the page came back full, so
 * there may be more history before it" (see `OvernightReport.eventsTruncated`).
 */
export function buildOvernightReport(
  since: string,
  events: readonly SinceEvent[],
  requestedLimit: number,
  costs: CostsPayload,
  liveAssignments: readonly BoardAssignment[],
): OvernightReport {
  const cutoff = Date.parse(since);
  const inWindow = events.filter((event) => {
    const ts = Date.parse(event.ts);
    return Number.isFinite(ts) && Number.isFinite(cutoff) && ts >= cutoff;
  });

  const merged: OvernightLine[] = [];
  const newlyBlocked: OvernightLine[] = [];
  for (const event of inWindow) {
    const line: OvernightLine = { itemId: event.itemId, itemTitle: event.itemTitle, ts: event.ts };
    if (event.type === "merge") merged.push(line);
    else if (movedTo(event, "blocked")) newlyBlocked.push(line);
  }

  const deadOrStalledNow = liveAssignments.filter(
    (assignment) => assignment.liveness === "dead" || assignment.liveness === "stalled",
  ).length;

  return {
    since,
    merged,
    newlyBlocked,
    deadOrStalledNow,
    cost: totalCost(costs),
    // The page came back exactly full AND still does not reach the cutoff:
    // the ledger may hold more history before what was fetched, and the
    // merged/newlyBlocked counts above are then a floor rather than the
    // whole window. A page that came back short of `requestedLimit` proves
    // the opposite — the read reached all the way to the ledger's start —
    // so there is nothing left to miss.
    eventsTruncated: events.length >= requestedLimit && !coversSince(events, cutoff),
  };
}

/** Whether the oldest event in the slice reaches back to (or past) the cutoff. */
function coversSince(events: readonly SinceEvent[], cutoff: number): boolean {
  if (!Number.isFinite(cutoff)) return true;
  let oldest = Infinity;
  for (const event of events) {
    const ts = Date.parse(event.ts);
    if (Number.isFinite(ts) && ts < oldest) oldest = ts;
  }
  return oldest <= cutoff;
}

/**
 * The default cutoff — 18:00 the previous local day, matching the task
 * brief's own example ("Since 18:00 yesterday"). Takes `now` rather than
 * reading the clock, so this is testable without freezing time globally
 * (matching `relativeTime` in `@/lib/projects/view.ts`).
 */
export function defaultCutoff(now: Date): string {
  const cutoff = new Date(now);
  cutoff.setHours(18, 0, 0, 0);
  if (cutoff.getTime() >= now.getTime()) {
    cutoff.setDate(cutoff.getDate() - 1);
  }
  return cutoff.toISOString();
}
