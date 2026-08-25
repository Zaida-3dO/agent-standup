// The "since your last visit" load lifecycle — the pure half of
// `SinceLastVisit.tsx`, split out for the same reason `src/lib/board/state.ts`
// is: this repo's harness runs `environment: "node"` with no DOM, so the
// fetch shaping, the query-string building and the loading/error/loaded
// branching are only directly testable as plain functions. The client
// component is thin wiring over these.
import type { SinceFeed } from "./types";
import { emptyFeed } from "./view";
import { uiApiPath } from "@/lib/ui-proxy/path";

export type SinceLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; feed: SinceFeed };

export interface FetchFeedOptions {
  /** Whose read state to resolve. `null` — no profile chosen — sends no `personId` at all. */
  readonly personId?: string | null;
  /** Show only what this profile has not seen. */
  readonly unseenOnly?: boolean;
  readonly since?: string;
  readonly limit?: number;
  /**
   * Ask for `payload` and `body` on every event. Omitted (not sent as
   * `full=false`) when falsy, matching `unseenOnly`'s own omission rule —
   * the server default is already `false`. A caller that only needs
   * `event.type`/`event.itemTitle` (the "what's new" list) should leave
   * this unset; `buildOvernightReport`'s `movedTo` is the one consumer
   * that reads `payload` and passes `full: true` for it.
   */
  readonly full?: boolean;
}

/**
 * Builds the `GET /api/events` query string.
 *
 * Its own exported function because the omission rules are the interesting
 * part and they are worth testing without a fetch in the way: **a null or
 * absent `personId` is omitted, not sent as an empty string.** The
 * operation's schema requires `personId` to be a non-empty string when
 * present, so `?personId=` would be an `invalid_input` rejection where
 * "nobody is signed in" is a perfectly legal read that returns the ledger
 * with everything unseen.
 *
 * `unseenOnly` is likewise omitted when false rather than sent as
 * `unseenOnly=false` — the server default is already false, and a query
 * string that spells out its defaults makes two identical requests look
 * different in a log.
 */
export function buildFeedQuery(options: FetchFeedOptions = {}): string {
  const params = new URLSearchParams();
  if (options.personId) params.set("personId", options.personId);
  if (options.unseenOnly) params.set("unseenOnly", "true");
  if (options.since !== undefined) params.set("since", options.since);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.full) params.set("full", "true");
  const query = params.toString();
  return query === "" ? uiApiPath("/api/events") : uiApiPath(`/api/events?${query}`);
}

/**
 * The feed from `GET /api/events`. Throws a message fit to show directly —
 * never a raw `Response` or a JSON-parse error, matching `fetchBoard` and
 * `fetchPeople`.
 *
 * **A partial response is filled in, not trusted.** The server always sends
 * every field, but a component that maps `feed.events` on a response
 * missing it would crash on `undefined.map`. Merging over `emptyFeed()`
 * degrades a malformed response into an empty feed rather than a blank
 * page — the same defence `fetchBoard` applies to a missing column.
 */
export async function fetchFeed(
  options: FetchFeedOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<SinceFeed> {
  const response = await fetchImpl(buildFeedQuery(options));
  if (!response.ok) {
    throw new Error(`Could not load what's new (GET /api/events returned ${response.status}).`);
  }
  const body = (await response.json()) as Partial<SinceFeed> | null;
  return { ...emptyFeed(), ...(body ?? {}) };
}

/**
 * Marks one event seen for one profile — `POST /api/events/{id}/seen`.
 *
 * The operation is idempotent, so a caller may send an id it has already
 * sent; this resolves rather than throwing on that case, because the server
 * answers 200 either way (see the route's header on why it does not
 * distinguish them by status).
 */
export async function markSeen(
  eventId: string,
  personId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(uiApiPath(`/api/events/${encodeURIComponent(eventId)}/seen`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ personId }),
  });
  if (!response.ok) {
    throw new Error(`Could not mark that as seen (returned ${response.status}).`);
  }
}

/**
 * Marks several events seen, one request each.
 *
 * **Sequential, and it stops at the first failure.** There is no bulk
 * endpoint (SCHEMA.md §19 defines `POST /events/{id}/seen`, singular), and
 * firing a screenful in parallel would open fifty connections to save a
 * fraction of a second on an action nobody is waiting on. Stopping on
 * failure means a partial result — which is *safe here specifically
 * because each write is independent and idempotent*: the ones that landed
 * stay landed, and repeating the whole action re-sends only what is still
 * unseen (`unseenEventIds`), so a retry converges rather than duplicating.
 */
export async function markManySeen(
  eventIds: readonly string[],
  personId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  for (const eventId of eventIds) {
    await markSeen(eventId, personId, fetchImpl);
  }
}

/**
 * Applies a successful "seen" locally, so the list updates without a
 * refetch.
 *
 * Returns a new feed rather than mutating: the caller holds this in React
 * state, where an in-place edit would not re-render. `unseenCount` is
 * recomputed from the events rather than decremented, so marking an event
 * that was *already* seen cannot drive the count below the truth — the
 * same idempotence the server guarantees, mirrored in the client's own
 * bookkeeping.
 */
export function applySeen(feed: SinceFeed, eventIds: readonly string[]): SinceFeed {
  const marked = new Set(eventIds);
  const events = feed.events.map((event) =>
    marked.has(event.id) && !event.seen ? { ...event, seen: true, seenByAnyone: true } : event,
  );
  return {
    ...feed,
    events,
    unseenCount: events.reduce((count, event) => (event.seen ? count : count + 1), 0),
    // A profile that has just marked something seen is, by definition, no
    // longer on its first visit — it now has read state. Leaving this true
    // would make the empty state say "nothing has happened yet" the moment
    // someone cleared a full list, which is the opposite of what happened.
    firstVisit: eventIds.length > 0 ? false : feed.firstVisit,
  };
}

/**
 * Appends a further page onto the feed already on screen.
 *
 * **The server's own cursor drives this; nothing is sliced client-side.**
 * `get_events` is keyset-paged on `Event.id` (`WHERE id > since ORDER BY id
 * ASC LIMIT n`), and its `cursor` is the slice's high-water mark taken
 * *before* `unseenOnly` filters anything — so handing that value straight
 * back as the next `since` is the one way to continue that cannot skip or
 * repeat a row. Fetching a bigger page and showing part of it would be the
 * mistake T24 (#265) removed from item history, and it re-reads the whole
 * prefix out of Postgres every time.
 *
 * ── Three properties this has to preserve ───────────────────────────────
 *
 *   1. **`unseenCount` is recomputed, never added up.** `applySeen` already
 *      recomputes rather than decrementing, precisely so an idempotent
 *      `mark_event_seen` cannot drive the count below the truth. Summing
 *      the incoming page's count onto the existing one would reintroduce
 *      exactly that class of drift from the other direction — and it would
 *      double-count any event that arrived on both pages.
 *   2. **A repeated id does not duplicate a row.** The cursor makes overlap
 *      unlikely rather than impossible: a caller that pages from a stale
 *      cursor, or a double-invoked handler, can legitimately re-deliver an
 *      event that is already on screen. De-duplicating by id here means a
 *      repeat is absorbed instead of rendering the same event twice under
 *      the same React key. The event already held wins, because it may
 *      carry a `seen` flag this profile has since set locally, and letting
 *      a fresh server row overwrite it would silently un-mark something the
 *      reader just cleared.
 *   3. **`firstVisit` and `horizon` come from the newer response.** The
 *      horizon moves forward as transactions commit, and it is the newer
 *      read that knows where it is now.
 *
 * Returns a new feed rather than mutating, like `applySeen`: the caller
 * holds this in React state, where an in-place edit would not re-render.
 */
export function appendPage(feed: SinceFeed, page: SinceFeed): SinceFeed {
  const known = new Set(feed.events.map((event) => event.id));
  const added = page.events.filter((event) => !known.has(event.id));
  const events = [...feed.events, ...added];
  return {
    ...feed,
    events,
    // The continuation's cursor is where the ledger has now been read to.
    cursor: page.cursor,
    horizon: page.horizon,
    unseenCount: events.reduce((count, event) => (event.seen ? count : count + 1), 0),
    firstVisit: page.firstVisit,
  };
}

/** Turns a caught value into the message the error state shows — never a raw, possibly-unhelpful object. */
export function sinceErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load what's new.";
}
