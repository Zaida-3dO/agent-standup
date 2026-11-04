// The Standup home's load lifecycle: fetching the page's data as plain
// functions. Split out for the reason `@/lib/board/state.ts` is: this repo's
// harness runs `environment: "node"` with no DOM. What the page makes of the
// data lives in `./view.ts`.
import { fetchFeed } from "@/lib/since/state";
import { fetchCosts } from "@/lib/costs/state";
import { fetchBoardColumn } from "@/lib/board/state";
import { emptyBoardQuery, type BoardQuery } from "@/lib/board/filters";
import { fetchProjects } from "@/lib/projects/state";
import { fetchNeedsYou } from "@/lib/needs-you/state";
import type { NeedsYouItem } from "@/lib/needs-you/types";
import type { ProjectsPayload } from "@/lib/projects/types";
import type { BoardColumnId, BoardEntry } from "@/lib/board/types";
import type { SinceEvent } from "@/lib/since/types";
import { buildOvernightReport, defaultCutoff, type OvernightReport } from "./overnight";

/**
 * How the overnight report reads the ledger.
 *
 * **Only the `merge` type is read, across a wide span, and slim.** The page
 * counts what finished and nothing else, so it asks the server for that one
 * type (`types` is filtered server-side). Reading "the last 50 events of any
 * type" let one burst of unrelated writes (a progress document patched a
 * thousand times in a row, say) push last night's merges out of the window;
 * asking for the one counted type over a span of `OVERNIGHT_SPAN_IDS` ledger
 * ids does not care what else was written. The slim shape is about a hundred
 * characters an event, which keeps the page far from the 200,000-character
 * response guard (`response-size.ts`) that refuses an oversized read and
 * blanks the section.
 *
 * The read starts `OVERNIGHT_SPAN_IDS` ids back from the newest and pages
 * forward in pages of `OVERNIGHT_PAGE_LIMIT`: while a page comes back full,
 * the next starts after its last id, up to `OVERNIGHT_MAX_PAGES` pages, so the
 * newest events are reached rather than cut off. If the cap is hit the
 * report says its count may be incomplete.
 */
const OVERNIGHT_SPAN_IDS = 2000;
const OVERNIGHT_PAGE_LIMIT = 200;
const OVERNIGHT_MAX_PAGES = 5;

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
 * page reads from the start, which is correct — a read that starts at the
 * ledger's first event has nothing before it to miss, which is why
 * `fetchOvernightEvents` reports `fromLedgerStart` and the page does not call
 * such a read truncated.
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

/** A board column read to its end (or to the page cap), as the Standup reads it. */
export interface ColumnRead {
  readonly entries: readonly BoardEntry[];
  /** The server's count of everything in the column; entries may be fewer when `capped`. */
  readonly total: number;
  /** True when the read stopped at `COLUMN_MAX_PAGES` with more still to come: counts are a floor. */
  readonly capped: boolean;
}

/** The needs-you set: the rows (one bounded page) and the server's count of all of them. */
export interface NeedsYouRead {
  readonly items: readonly NeedsYouItem[];
  readonly total: number;
}

export interface StandupData {
  /** Whose page this is; the view tells "blocked on you" from "blocked on someone else" by it. */
  readonly viewerId: string | null;
  /** What finished since the cutoff, and the spend over the same window. */
  readonly overnight: SectionState<OvernightReport>;
  /** Every in-progress entry at any depth below a project: live work and stopped agents. */
  readonly inProgress: SectionState<ColumnRead>;
  /** Every paused or blocked entry: the stuck list is read from here. */
  readonly waiting: SectionState<ColumnRead>;
  readonly projects: SectionState<ProjectsPayload>;
  readonly needsYou: SectionState<NeedsYouRead>;
}

export type StandupLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: StandupData };

/** What one filtered feed read came back with. */
interface OvernightRead {
  readonly events: SinceEvent[];
  /** True when a read hit `OVERNIGHT_MAX_PAGES` still full: the newest events may be missing. */
  readonly capped: boolean;
}

/** The overnight read, plus whether it began at the ledger's very first event. */
interface OvernightEventsRead extends OvernightRead {
  /**
   * True when the span began at the start of the ledger (an empty ledger, or
   * a newest id no larger than the span): nothing older exists to be missed,
   * so a window that is not provably covered is still complete.
   */
  readonly fromLedgerStart: boolean;
}

/**
 * Reads one filtered feed forward from `since`, a page at a time.
 *
 * Follows on from the last id of a full page, up to `OVERNIGHT_MAX_PAGES`
 * pages. Returns whether the cap was hit with the last page still full.
 */
async function readPages(
  base: {
    personId: string | null;
    since: string | undefined;
    types: readonly string[];
  },
  fetchImpl: typeof fetch,
): Promise<OvernightRead> {
  const events: SinceEvent[] = [];
  let since = base.since;
  for (let page = 1; page <= OVERNIGHT_MAX_PAGES; page += 1) {
    const result = await fetchFeed(
      { personId: base.personId, limit: OVERNIGHT_PAGE_LIMIT, since, types: base.types },
      fetchImpl,
    );
    events.push(...result.events);
    if (result.events.length < OVERNIGHT_PAGE_LIMIT) return { events, capped: false };
    since = result.events[result.events.length - 1]!.id;
  }
  return { events, capped: true };
}

/**
 * The events the overnight report is built from: the merges, read slim.
 *
 * Also reads the first event of the span, of any type, as an **anchor**. With
 * one type filtered, a quiet span can hold no merge old enough to prove the
 * read reached the cutoff, and the report would claim to be incomplete on a
 * perfectly quiet night. The anchor is the oldest event the span holds, so its
 * time answers "does this span reach back to the cutoff" whatever the types in
 * it. It is a real event, de-duplicated by id, so it never counts twice (and
 * the report only counts it if it is itself a merge).
 *
 * Throws if a read fails: the overnight section then shows its own error line
 * rather than a confident "nothing finished".
 */
async function fetchOvernightEvents(
  personId: string | null,
  fetchImpl: typeof fetch,
): Promise<OvernightEventsRead> {
  // The overnight report is about *last night*, so it must read the END of
  // the ledger. `readSinceBounded` is `WHERE id > since ORDER BY id ASC`, so
  // a fetch with no `since` starts at the ledger's beginning and LIMIT takes
  // the OLDEST rows, and the report renders a confident "0 merged" about
  // events from months ago. The window is wrong at any page size.
  //
  // A cheap first probe gets `newestId` (the highest visible event id), and
  // the real reads then start one span back from it. Two round-trips rather
  // than one, deliberately: `since` is an id cursor and takes no timestamp,
  // so this is the only way to reach the tail without widening the API.
  //
  // It must be `newestId` and not `horizon`: the horizon is a transaction id
  // bounding `txId`, not a position in the `id` sequence `since` pages over.
  // See `tailCursor` for what conflating them did.
  const probe = await fetchFeed({ personId, limit: 1 }, fetchImpl);
  const tailStart = tailCursor(probe.newestId, OVERNIGHT_SPAN_IDS);
  // An empty ledger, or one whose newest id is within the span, is read from its first
  // event. An unparseable id is not "from the start": `tailCursor` read it as
  // unknown, so the read falls back to an unbounded `since` it cannot vouch for.
  const fromLedgerStart =
    probe.newestId === null ||
    (/^\d+$/.test(probe.newestId.trim()) &&
      BigInt(probe.newestId.trim()) <= BigInt(OVERNIGHT_SPAN_IDS));

  const [merges, anchor] = await Promise.all([
    readPages({ personId, since: tailStart, types: ["merge"] }, fetchImpl),
    fetchFeed({ personId, limit: 1, since: tailStart }, fetchImpl),
  ]);

  const mergeIds = new Set(merges.events.map((event) => event.id));
  return {
    events: [...merges.events, ...anchor.events.filter((event) => !mergeIds.has(event.id))],
    capped: merges.capped,
    fromLedgerStart,
  };
}

/**
 * The board query for the two live columns: every level except projects.
 *
 * The board's default is level 1 only, which would hide an executing subtask
 * under a task and so under-count the agents and the live work. A project row
 * has no column of its own (it is computed from its subtree), so level 0 is
 * excluded rather than filtered out later.
 */
const LIVE_COLUMN_QUERY: BoardQuery = {
  ...emptyBoardQuery(),
  filters: { level: { mode: "exclude", levels: [0] } },
};

/**
 * How many pages of a column are followed before the read says it is capped.
 * Enough for several hundred entries, so "6 agents" is not a page-size
 * artefact, while still bounding the page's worst case.
 */
export const COLUMN_MAX_PAGES = 10;

/** How many projects the rollup read asks for (the operation's maximum). */
export const PROJECTS_LIMIT = 200;

/**
 * Reads one board column, following `nextCursor` until it runs out.
 *
 * Throws if any page fails: a half-read column would under-count with no sign
 * of it, so the section shows its error line instead.
 */
async function readColumn(column: BoardColumnId, fetchImpl: typeof fetch): Promise<ColumnRead> {
  const entries: BoardEntry[] = [];
  let total = 0;
  let cursor: string | undefined;
  for (let page = 1; page <= COLUMN_MAX_PAGES; page += 1) {
    const section = await fetchBoardColumn(column, {
      fetchImpl,
      query: LIVE_COLUMN_QUERY,
      withContext: true,
      ...(cursor === undefined ? {} : { cursor }),
    });
    entries.push(...section.entries);
    if (page === 1) total = section.total;
    if (!section.nextCursor) {
      return { entries, total: Math.max(total, entries.length), capped: false };
    }
    cursor = section.nextCursor;
  }
  return { entries, total: Math.max(total, entries.length), capped: true };
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
 * Six reads in parallel: they are independent (the merged events, a costs
 * total, two board columns, the projects rollup and the needs-you set), so
 * serialising them would make first paint wait on the slowest for no benefit.
 *
 * **They settle independently (`Promise.allSettled`), and this never
 * rejects.** Each section carries its own result, and a failed one is a short
 * error line in its own place while the rest render. `./view.ts` drops any
 * sentence clause whose data failed rather than stating a zero for it.
 *
 * The overnight section is composed from two reads: events are essential to
 * it and costs are not, so a failed costs read hides spend
 * (`costUnavailable`) without erasing the finished list.
 */
export async function fetchStandup(
  personId: string | null,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<StandupData> {
  const since = defaultCutoff(now);

  const [events, costs, inProgress, waiting, projects, needsYou] = await Promise.allSettled([
    fetchOvernightEvents(personId, fetchImpl),
    fetchCosts({ groupBy: "stage", since }, fetchImpl),
    readColumn("in_progress", fetchImpl),
    readColumn("waiting", fetchImpl),
    fetchProjects({ limit: PROJECTS_LIMIT, fetchImpl }),
    fetchNeedsYou(personId, fetchImpl),
  ]);

  return {
    viewerId: personId,
    overnight: sectionOf(events, ({ events: eventList, capped, fromLedgerStart }) => {
      const report = buildOvernightReport(
        since,
        eventList,
        costs.status === "fulfilled" ? costs.value : null,
      );
      // A capped read stopped before the newest events: the count is a
      // floor, which is what `eventsTruncated` says.
      // A read that began at the ledger's first event cannot have missed
      // anything older, so the report's own "not provably covered" is dropped.
      const eventsTruncated = capped || (report.eventsTruncated && !fromLedgerStart);
      return { ...report, eventsTruncated };
    }),
    inProgress: sectionOf(inProgress, (column) => column),
    waiting: sectionOf(waiting, (column) => column),
    projects: sectionOf(projects, (payload) => payload),
    // `fetchNeedsYou` returns the page and its `total`; the sentence and the
    // panel's count read the total, the rows read the page.
    needsYou: sectionOf(needsYou, (page) => ({ items: page.items, total: page.total })),
  };
}

/** Turns a caught value into the message the error state shows. */
export function standupErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load the Standup home.";
}
