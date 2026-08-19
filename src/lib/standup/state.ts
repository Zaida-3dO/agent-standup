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

/** The events page size the overnight report reads — the max a single `get_events` call allows. */
const OVERNIGHT_EVENTS_LIMIT = 200;

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

  const [feed, costs, inProgress, projects, needsYou] = await Promise.all([
    fetchFeed({ personId, limit: OVERNIGHT_EVENTS_LIMIT }, fetchImpl),
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
