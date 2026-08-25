// The live feed's transport and its pacing — T17, part 1.
//
// **Polling, not SSE, and the reason is written down here because the row
// asks for it.** `GET /api/events?since=` already exists and is already
// correct under concurrent transactions: `readSinceBounded` bounds the slice
// by `txId < visibilityHorizon(db)` as well as by `id > since`, which is the
// property that makes "since" safe when transactions commit out of order.
// An SSE endpoint would need that same cursor and would add: a long-lived
// connection through the NAS reverse proxy, whose buffering behaviour nobody
// here has measured; a second read path to keep in step with the first; and
// a reconnect story that lands back on exactly this `since=` call anyway.
// The poll reuses the endpoint that is already proven, and the reconnect
// story is "the next tick". SSE remains available as a later optimisation if
// measured latency is ever a real complaint — it would replace `pollLive`
// below and nothing else, because everything above this file is a pure
// function over the slice.
//
// Everything here takes its `fetch` as a parameter for the same reason
// `move.ts` does: it makes the transport directly testable with a stub, with
// no DOM and no server.
import { uiApiPath } from "@/lib/ui-proxy/path";
import { advanceCursor, isCursor } from "./cursor";
import type { LiveEvent, LiveEventsResponse } from "./events";

/**
 * How often to ask, in milliseconds, and how far to back off when asking
 * fails.
 *
 * **The backoff is on failure only, not on an empty slice.** An idle board
 * that polls every 5s costs one bounded read of an indexed table; an idle
 * board that has backed off to a minute takes a minute to show a teammate's
 * move, which is the whole thing this row is for. What must back off is a
 * *failing* poll — a server that is down, restarting or refusing, where
 * continuing at 5s turns one outage into a request flood from every open
 * tab.
 */
export const POLL_INTERVAL_MS = 5_000;
export const MAX_BACKOFF_MS = 60_000;

/**
 * The delay before the next attempt, given how many have failed in a row.
 *
 * Doubles from the base interval and is capped, so a long outage settles at
 * one request a minute per tab rather than growing without bound. Zero
 * consecutive failures is the ordinary interval.
 */
export function backoffDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return POLL_INTERVAL_MS;
  const scaled = POLL_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 10);
  return Math.min(scaled, MAX_BACKOFF_MS);
}

/** What one poll produced. A failure is an ordinary outcome, not a throw — see `move.ts`. */
export type PollResult =
  | { readonly ok: true; readonly events: readonly LiveEvent[]; readonly cursor: string }
  | { readonly ok: false };

/**
 * Reads everything that has happened since `cursor`.
 *
 * **`full=true`, deliberately.** The slim shape omits `payload`, and
 * `payload {from, to}` is what makes a conflict message able to say *where*
 * someone moved a card. The response-size reasoning behind the slim default
 * (`get_events`'s header: a page of 50 full events measured ~360,000
 * characters) is about a screenful of *history*; a poll's slice is whatever
 * happened in the last few seconds, which is normally zero rows and rarely
 * more than a handful. `limit` is left at the server's default so an
 * unusually busy interval is still bounded.
 *
 * **The returned cursor is the server's own**, passed through `advanceCursor`
 * so it can only move forward — two polls in flight at once cannot rewind it
 * and replay a slice already applied. A response whose cursor is missing or
 * malformed leaves the held one untouched rather than resetting to zero,
 * which would re-read the whole ledger.
 *
 * A non-2xx or an unreachable server returns `{ ok: false }`. The cursor is
 * *not* advanced on a failure — nothing was read, so nothing has been seen,
 * and the next attempt asks for the same slice again.
 */
export async function pollLive(
  cursor: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<PollResult> {
  const since = isCursor(cursor) ? cursor : "0";
  let response: Response;
  try {
    response = await fetchImpl(
      uiApiPath(`/api/events?since=${encodeURIComponent(since)}&full=true`),
      signal === undefined ? undefined : { signal },
    );
  } catch {
    return { ok: false };
  }
  if (!response.ok) return { ok: false };

  let body: LiveEventsResponse;
  try {
    body = (await response.json()) as LiveEventsResponse;
  } catch {
    return { ok: false };
  }

  // A body that is not the shape this expects is a failure rather than an
  // empty slice: reporting "nothing happened" for a response nobody could
  // read would let the board sit silently stale forever.
  if (!Array.isArray(body?.events)) return { ok: false };

  return {
    ok: true,
    events: body.events,
    cursor: advanceCursor(since, body.cursor),
  };
}
