// The overnight report: what finished since the cutoff, and what it cost.
// Built over the shapes that already exist rather than a parallel
// computation of its own.
//
// **Merges come from `get_events`** (`@/lib/since/types`, `GET /api/events`),
// the same ledger `/activity` renders, read here for a cutoff rather than a
// cursor. `get_events`'s own `since` is an event-id cursor, not a timestamp,
// so the caller reads a bounded slice of the ledger's tail and this filters
// by `ts` client-side. That is a real constraint worth naming: a cutoff more
// than the slice older than the read would silently under-report, because the
// slice would run out before reaching it. See `OvernightReport.eventsTruncated`.
//
// **Spend comes from `get_costs`** (`@/lib/costs/types`, `GET /api/costs`).
// `since` there genuinely is a timestamp, so the cutoff reaches it exactly.
//
// Stuck work and agents that stopped responding are not read from here: they
// are live-state questions answered by the board columns (`./view.ts`).
import type { SinceEvent } from "@/lib/since/types";
import type { CostsPayload } from "@/lib/costs/types";
import { totalCost } from "@/lib/costs/state";

/** One finished item the report can show, in the reader's terms. */
export interface OvernightLine {
  readonly itemId: string | null;
  readonly itemTitle: string | null;
  readonly ts: string;
  /** The item's top-level project, or null for an orphan (or a read that predates the field). */
  readonly project: { readonly id: string; readonly title: string } | null;
}

export interface OvernightReport {
  readonly since: string;
  readonly merged: readonly OvernightLine[];
  /** Recomputed spend since the cutoff, or null when nothing in the window could be priced. */
  readonly cost: number | null;
  /**
   * True when the costs read itself failed, as opposed to succeeding with
   * nothing priceable. Both leave `cost` null; the page hides spend in both,
   * but they are different facts about the read.
   */
  readonly costUnavailable: boolean;
  /**
   * True when the events slice this was built from may have run out before
   * reaching `since`: the merged count is then a floor, not the whole window.
   */
  readonly eventsTruncated: boolean;
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
  costs: CostsPayload | null,
): OvernightReport {
  const cutoff = Date.parse(since);
  const inWindow = events.filter((event) => {
    const ts = Date.parse(event.ts);
    return Number.isFinite(ts) && Number.isFinite(cutoff) && ts >= cutoff;
  });

  const merged: OvernightLine[] = [];
  for (const event of inWindow) {
    if (event.type !== "merge") continue;
    merged.push({
      itemId: event.itemId,
      itemTitle: event.itemTitle,
      ts: event.ts,
      project: event.project ?? null,
    });
  }

  return {
    since,
    merged,
    cost: costs === null ? null : totalCost(costs),
    costUnavailable: costs === null,
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
