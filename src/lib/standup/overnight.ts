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
 * **It deliberately does not take the page size.** Whether the report
 * covers its window is a question about the slice's oldest row, not about
 * how many rows came back; comparing the length against the requested limit
 * was what let an empty page pass as complete. Removing the parameter
 * rather than ignoring it is the point — a page size still in the signature
 * reads as though it governs the answer, and the next reader would use it.
 */
export function buildOvernightReport(
  since: string,
  events: readonly SinceEvent[],
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
    // Whether the window this report claims to cover was actually reached.
    //
    // The question is only ever "does the slice reach back to the cutoff",
    // and `coversSince` answers it directly. Qualifying that with "and the
    // page came back full" was the hole: a page **shorter** than
    // `requestedLimit` was read as proof the slice had reached the ledger's
    // start, when it equally means the read landed past the ledger's end and
    // returned nothing. An empty page made `0 >= 15` false and the report
    // declared itself complete while covering no events at all — the guard
    // that exists for exactly this under-reporting, reporting `false` in the
    // one case where it was most needed.
    //
    // Answering on coverage alone is correct in both directions: a genuinely
    // short page that *does* reach past the cutoff still reports `false`
    // (nothing was missed — the ledger simply starts inside the window), and
    // a page that does not reach the cutoff reports `true` whatever its
    // length, because the counts are then a floor rather than the window.
    eventsTruncated: !coversSince(events, cutoff),
  };
}

/**
 * Whether the oldest event in the slice reaches back to (or past) the cutoff.
 *
 * An **empty** slice answers `false`: `oldest` stays `Infinity`, which is
 * not `<= cutoff`. That is the intended answer and the one the truncation
 * flag depends on — a read that returned nothing has demonstrated nothing
 * about the window, so the report must not claim to cover it.
 */
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
