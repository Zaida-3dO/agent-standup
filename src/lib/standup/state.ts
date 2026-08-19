// The Standup home's load lifecycle — fetching the four blocks' data and
// composing the overnight report, as plain functions. Split out for the
// reason `@/lib/board/state.ts` is: this repo's harness runs
// `environment: "node"` with no DOM.
import { fetchFeed } from "@/lib/since/state";
import { fetchCosts } from "@/lib/costs/state";
import { fetchBoardColumn } from "@/lib/board/state";
import { fetchProjects } from "@/lib/projects/state";
import { fetchNeedsYou } from "@/lib/needs-you/state";
import type { NeedsYouItem } from "@/lib/needs-you/types";
import type { ProjectsPayload } from "@/lib/projects/types";
import type { BoardEntry } from "@/lib/board/types";
import { buildOvernightReport, defaultCutoff, type OvernightReport } from "./overnight";

/**
 * The events page size the overnight report reads.
 *
 * **Not the max `get_events` allows.** This fetch asks for `full: true`
 * (`buildOvernightReport`'s `movedTo` needs `payload.to` to tell a
 * `state_change` into `blocked` from any other field change), so it pays
 * the same per-event size the response-size guard was filed over: one event
 * measured at 7,398 characters full, and a 200-row full page was the
 * concrete read that broke `/api/events` with a 547,961-character response
 * against the 200,000-character guard (`response-size.ts`). 15 is a
 * conservative page at that per-event size, with real margin below the
 * guard rather than riding its edge — an installation whose events run
 * larger than measured still has the guard itself as a backstop, so this
 * number degrading gracefully (via `OvernightReport.eventsTruncated`)
 * matters more than it being exact.
 */
const OVERNIGHT_EVENTS_LIMIT = 15;

/**
 * The `since` cursor that lands a page of `limit` rows at the ledger's tail.
 *
 * `horizon` is the newest id a read can see, and ids are a gapless-enough
 * sequence that `horizon - limit` is a good page boundary: too low and the
 * page is merely larger than asked for (the LIMIT still bounds it), never
 * smaller. Clamped at 0 so a ledger shorter than one page reads from the
 * start, which is correct — there is nothing before it to miss.
 *
 * Returns `undefined` on an unparseable horizon so the caller falls back to
 * an unbounded `since`, which is the pre-existing behaviour rather than a
 * new failure mode.
 */
export function tailCursor(horizon: string, limit: number): string | undefined {
  // `BigInt("")` is 0n rather than a throw, so an empty horizon would silently
  // become a read from the ledger's start — the exact bug this exists to stop.
  // Demand digits explicitly instead of relying on the constructor to refuse.
  if (!/^\d+$/.test(horizon.trim())) return undefined;
  const parsed = BigInt(horizon.trim());
  const start = parsed - BigInt(limit);
  return (start > 0n ? start : 0n).toString();
}

export interface StandupData {
  readonly overnight: OvernightReport;
  /** Every in-progress entry, live assignments included — "in flight now". */
  readonly inFlight: readonly BoardEntry[];
  readonly projects: ProjectsPayload;
  /** The full needs-you set — unsorted; the Standup view takes the count and the top few. */
  readonly needsYou: readonly NeedsYouItem[];
}

export type StandupLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: StandupData };

/**
 * Fetches everything the Standup home renders, for one profile.
 *
 * Five reads in parallel: they are independent (an events slice, a costs
 * total, one board column, the projects rollup, the needs-you set — itself
 * three parallel reads inside `fetchNeedsYou`), so serialising them would
 * make first paint wait on the slowest for no benefit — matching
 * `fetchBoard`'s own reasoning for its four column reads.
 */
export async function fetchStandup(
  personId: string | null,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<StandupData> {
  const since = defaultCutoff(now);

  // The overnight report is about *last night*, so it must read the END of
  // the ledger. `readSinceBounded` is `WHERE id > since ORDER BY id ASC`, so
  // a fetch with no `since` starts at the ledger's beginning and LIMIT takes
  // the OLDEST rows — on this installation that is the 2026-08-14 import,
  // and the report renders a confident "0 merged" about events from months
  // ago. A large page can hide this on a young ledger by reaching far enough
  // to cover last night by accident; the window is wrong at any page size,
  // and the smaller the page the more certainly it shows.
  //
  // A cheap first probe gets `horizon` (the newest visible event id), and the
  // real read then starts one page back from it. Two round-trips rather than
  // one, deliberately: `since` is an id cursor and takes no timestamp, so
  // this is the only way to reach the tail without widening the API.
  const probe = await fetchFeed({ personId, limit: 1 }, fetchImpl);
  const tailStart = tailCursor(probe.horizon, OVERNIGHT_EVENTS_LIMIT);

  const [feed, costs, inProgress, projects, needsYou] = await Promise.all([
    // `full: true` — see `OVERNIGHT_EVENTS_LIMIT`'s own comment on why this
    // fetch, alone among this file's reads, needs the heavy shape.
    fetchFeed({ personId, limit: OVERNIGHT_EVENTS_LIMIT, full: true, since: tailStart }, fetchImpl),
    fetchCosts({ groupBy: "stage", since }, fetchImpl),
    fetchBoardColumn("in_progress", { fetchImpl }),
    fetchProjects({ fetchImpl }),
    fetchNeedsYou(personId, fetchImpl),
  ]);

  const liveAssignments = inProgress.entries.flatMap((entry) => entry.assignments);
  const overnight = buildOvernightReport(
    since,
    feed.events,
    OVERNIGHT_EVENTS_LIMIT,
    costs,
    liveAssignments,
  );

  return { overnight, inFlight: inProgress.entries, projects, needsYou };
}

/** Turns a caught value into the message the error state shows. */
export function standupErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load the Standup home.";
}
