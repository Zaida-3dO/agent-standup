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
 * **Takes the newest event `id`, and nothing else will do.** `since` is
 * compared against `id`, so only a value from that same sequence can be
 * decremented into a page boundary. The visibility `horizon` is a Postgres
 * transaction id (`pg_snapshot_xmin`) bounding `txId`; it counts
 * transactions, while `id` counts events, so the two diverge without limit
 * — one transaction may append several events or none. Measured on a live
 * installation the horizon stood at 28,817 while the newest event id was
 * 15,360, so a cursor derived from the horizon started roughly 13,400 rows
 * past the end of the ledger and every page came back **empty**. That is
 * the worst possible failure shape here: an empty page is indistinguishable
 * from a quiet night, so the report rendered a confident "0 merged, 0
 * blocked" while spend — which reaches its data by a real timestamp bound —
 * showed thousands of dollars of activity over the same window.
 *
 * Ids are a gapless-enough sequence that `newestId - limit` is a good page
 * boundary: too low and the page is merely larger than asked for (the LIMIT
 * still bounds it), never smaller. Clamped at 0 so a ledger shorter than one
 * page reads from the start, which is correct — there is nothing before it
 * to miss.
 *
 * Returns `undefined` for a `null` or unparseable id so the caller falls
 * back to an unbounded `since`. That fallback reads the ledger's *start*
 * rather than its tail, which is wrong for this report — but it is wrong
 * *visibly*, because a page of ancient rows fails to reach the cutoff and
 * `eventsTruncated` says so, where the empty page did not.
 */
export function tailCursor(newestId: string | null, limit: number): string | undefined {
  // `BigInt("")` is 0n rather than a throw, so an empty id would silently
  // become a read from the ledger's start — the exact bug this exists to stop.
  // Demand digits explicitly instead of relying on the constructor to refuse.
  if (newestId === null || !/^\d+$/.test(newestId.trim())) return undefined;
  const parsed = BigInt(newestId.trim());
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
  // A cheap first probe gets `newestId` (the highest visible event id), and
  // the real read then starts one page back from it. Two round-trips rather
  // than one, deliberately: `since` is an id cursor and takes no timestamp,
  // so this is the only way to reach the tail without widening the API.
  //
  // It must be `newestId` and not `horizon`: the horizon is a transaction id
  // bounding `txId`, not a position in the `id` sequence `since` pages over.
  // See `tailCursor` for what conflating them did.
  const probe = await fetchFeed({ personId, limit: 1 }, fetchImpl);
  const tailStart = tailCursor(probe.newestId, OVERNIGHT_EVENTS_LIMIT);

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
  const overnight = buildOvernightReport(since, feed.events, costs, liveAssignments);

  // `fetchNeedsYou` returns the page and its `total` since T24; this screen
  // renders the rows only, so it takes the items and leaves the count.
  return { overnight, inFlight: inProgress.entries, projects, needsYou: needsYou.items };
}

/** Turns a caught value into the message the error state shows. */
export function standupErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load the Standup home.";
}
