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
import type { SinceEvent } from "@/lib/since/types";
import { buildOvernightReport, defaultCutoff, type OvernightReport } from "./overnight";

/**
 * The events page size the overnight report reads.
 *
 * **Two reads share it, and they cost very different amounts per row.** The
 * main read is slim (id, type, item, time: about a hundred characters an
 * event), which is all a merge needs. Only `state_change` events are read in
 * full, because `buildOvernightReport`'s `movedTo` needs `payload.to` to tell
 * a move into `blocked` from any other change, and that read is filtered on
 * the server (`types: ["state_change"]`), so it never pays the heavy shape for
 * the other kinds. The earlier version read every event in full: 15 of them
 * measured about 700,000 characters against the 200,000-character response guard
 * (`response-size.ts`), `/api/events` came back 422, and the whole page went
 * blank with it.
 *
 * Both reads start from the same cursor and ask for the same number of rows,
 * so the full `state_change` read covers the window the slim read covers (or
 * a little past its end), never fewer of the recent ones. 50 is a page the
 * slim shape carries comfortably and a `state_change` payload (a from/to
 * pair) leaves far below the guard. Should an installation's payloads run
 * larger, the guard is still the backstop, and the failure is now confined to
 * the overnight section.
 */
const OVERNIGHT_EVENTS_LIMIT = 50;

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

/**
 * One section of the Standup home: its data, or the short line saying why
 * that section alone could not load. A failed read in one section never
 * reaches the others.
 */
export type SectionState<T> = { status: "loaded"; data: T } | { status: "error"; message: string };

export interface StandupData {
  readonly overnight: SectionState<OvernightReport>;
  /** Every in-progress entry, live assignments included: "in flight now". */
  readonly inFlight: SectionState<readonly BoardEntry[]>;
  readonly projects: SectionState<ProjectsPayload>;
  /** The full needs-you set, unsorted; the Standup view takes the count and the top few. */
  readonly needsYou: SectionState<readonly NeedsYouItem[]>;
}

export type StandupLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: StandupData };

/**
 * Lays the full `state_change` events over the slim slice.
 *
 * The slim slice is the report's view of the window (merges need nothing
 * more); the full read supplies `payload` for the one type that needs it. A
 * full event replaces the slim one with the same id; a full event the slim
 * page did not reach (it is newer, since both start from the same cursor) is
 * kept rather than dropped. Nothing else is touched, so every event the slim
 * read returned is still there for the report to measure its window by.
 */
export function overlayStateChanges(
  slim: readonly SinceEvent[],
  stateChanges: readonly SinceEvent[],
): SinceEvent[] {
  const fullById = new Map(stateChanges.map((event) => [event.id, event]));
  const slimIds = new Set(slim.map((event) => event.id));
  const merged = slim.map((event) => fullById.get(event.id) ?? event);
  for (const event of stateChanges) {
    if (!slimIds.has(event.id)) merged.push(event);
  }
  return merged;
}

/**
 * The events the overnight report is built from: the ledger's tail read slim,
 * with the `state_change` events read in full and laid over it.
 *
 * Throws if any of its reads fail. That is deliberate: a missing
 * `state_change` read would leave moves into `blocked` unclassifiable, and a
 * report that quietly showed "0 newly blocked" for that reason would be the
 * confident wrong answer `tailCursor`'s notes warn about. The overnight
 * section shows its own error line instead.
 */
async function fetchOvernightEvents(
  personId: string | null,
  fetchImpl: typeof fetch,
): Promise<SinceEvent[]> {
  // The overnight report is about *last night*, so it must read the END of
  // the ledger. `readSinceBounded` is `WHERE id > since ORDER BY id ASC`, so
  // a fetch with no `since` starts at the ledger's beginning and LIMIT takes
  // the OLDEST rows, and the report renders a confident "0 merged" about
  // events from months ago. A large page can hide this on a young ledger by
  // reaching far enough to cover last night by accident; the window is wrong
  // at any page size, and the smaller the page the more certainly it shows.
  //
  // A cheap first probe gets `newestId` (the highest visible event id), and
  // the real reads then start one page back from it. Two round-trips rather
  // than one, deliberately: `since` is an id cursor and takes no timestamp,
  // so this is the only way to reach the tail without widening the API.
  //
  // It must be `newestId` and not `horizon`: the horizon is a transaction id
  // bounding `txId`, not a position in the `id` sequence `since` pages over.
  // See `tailCursor` for what conflating them did.
  const probe = await fetchFeed({ personId, limit: 1 }, fetchImpl);
  const tailStart = tailCursor(probe.newestId, OVERNIGHT_EVENTS_LIMIT);

  const [slim, stateChanges] = await Promise.all([
    fetchFeed({ personId, limit: OVERNIGHT_EVENTS_LIMIT, since: tailStart }, fetchImpl),
    // `full` only for `state_change`: see `OVERNIGHT_EVENTS_LIMIT`.
    fetchFeed(
      {
        personId,
        limit: OVERNIGHT_EVENTS_LIMIT,
        since: tailStart,
        full: true,
        types: ["state_change"],
      },
      fetchImpl,
    ),
  ]);
  return overlayStateChanges(slim.events, stateChanges.events);
}

/** Turns one settled read into the state of its section, mapping the value on success. */
function sectionOf<T, U>(result: PromiseSettledResult<T>, pick: (value: T) => U): SectionState<U> {
  return result.status === "fulfilled"
    ? { status: "loaded", data: pick(result.value) }
    : { status: "error", message: standupErrorMessageFrom(result.reason) };
}

/**
 * Fetches everything the Standup home renders, for one profile.
 *
 * Five reads in parallel: they are independent (an events slice, a costs
 * total, one board column, the projects rollup, the needs-you set, itself
 * three parallel reads inside `fetchNeedsYou`), so serialising them would
 * make first paint wait on the slowest for no benefit, matching
 * `fetchBoard`'s own reasoning for its four column reads.
 *
 * **They settle independently (`Promise.allSettled`), and this never
 * rejects.** The reads used to share one `Promise.all`, so the first failure
 * threw away the others and the page showed nothing but one error. Each
 * section now carries its own result, and a failed one is a short error line
 * in its own place while the rest render.
 *
 * The overnight report is composed from three reads (events, costs, and the
 * in-progress column for its dead-or-stalled count). Events are essential to
 * it; costs and the in-progress column are not, so their failure degrades
 * just their own figure ("—" with a line saying why) rather than erasing the
 * merged and blocked counts.
 */
export async function fetchStandup(
  personId: string | null,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<StandupData> {
  const since = defaultCutoff(now);

  const [events, costs, inProgress, projects, needsYou] = await Promise.allSettled([
    fetchOvernightEvents(personId, fetchImpl),
    fetchCosts({ groupBy: "stage", since }, fetchImpl),
    fetchBoardColumn("in_progress", { fetchImpl }),
    fetchProjects({ fetchImpl }),
    fetchNeedsYou(personId, fetchImpl),
  ]);

  return {
    overnight: sectionOf(events, (eventList) =>
      buildOvernightReport(
        since,
        eventList,
        costs.status === "fulfilled" ? costs.value : null,
        inProgress.status === "fulfilled"
          ? inProgress.value.entries.flatMap((entry) => entry.assignments)
          : null,
      ),
    ),
    inFlight: sectionOf(inProgress, (column) => column.entries),
    projects: sectionOf(projects, (payload) => payload),
    // `fetchNeedsYou` returns the page and its `total` since T24; this screen
    // renders the rows only, so it takes the items and leaves the count.
    needsYou: sectionOf(needsYou, (page) => page.items),
  };
}

/** Turns a caught value into the message the error state shows. */
export function standupErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load the Standup home.";
}
