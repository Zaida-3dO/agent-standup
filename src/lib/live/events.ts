// What a live event means to the board — T17, part 1's "the client applies
// deltas".
//
// Everything here is a pure function over the slim `GET /api/events` row, for
// the same reason `drag.ts` is pure: this repo's harness runs
// `environment: "node"` with no DOM, so the decision "does this event change
// what the board is showing, and for which card" is only directly testable as
// a function. The hook in `use-live-board.ts` is thin wiring over these.
//
// **No new event data was needed for any of this.** `state_change` already
// carries `payload {from, to}` and every row already carries `actorType`,
// `actorId`, `sessionId` and `ts` — so "Bunmi moved this to In Review 12s
// ago" is answerable from the ledger the poll is reading anyway. The one
// thing that needs `full: true` is `payload`, which is why the poll asks for
// it: see `pollLive`.

/**
 * One row of `GET /api/events?full=true`, narrowed to what the board reads.
 *
 * Deliberately structural rather than an import of `SinceEventFull` from the
 * service layer: this is the shape as it arrives over the wire in a browser,
 * where nothing has validated it, so every field is treated as untrusted
 * below. `src/components/**` cannot import the service layer at all
 * (`npm run check:db-imports`), and the fields are few.
 */
export interface LiveEvent {
  readonly id: string;
  readonly itemId: string | null;
  readonly itemTitle: string | null;
  readonly ts: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly sessionId: string | null;
  readonly payload?: Record<string, unknown> | null;
}

/** The `GET /api/events` body, as far as this module relies on it. */
export interface LiveEventsResponse {
  readonly events: readonly LiveEvent[];
  readonly cursor: string;
}

/**
 * The event types that change what a board card shows.
 *
 * **A deliberately short list, and short in one direction.** Everything here
 * either moves a card between columns or changes something drawn on its
 * face; a `note` or a `checkpoint` changes neither, and refetching the board
 * for one would mean a full board read every time any agent anywhere writes a
 * progress line — which on this system is constantly. The cost of being
 * wrong in this direction is a card that is briefly stale until the next
 * event that *is* material; the cost of the other direction is a board that
 * re-reads itself into a loop.
 *
 * `field_change` is included because it covers priority, title, headline and
 * the blocked/paused fields, all of which the card draws.
 */
const MATERIAL_TYPES: ReadonlySet<string> = new Set([
  "state_change",
  "field_change",
  "claim",
  "release",
  "takeover",
  "merge",
  "review",
  "review_requested",
]);

/**
 * Whether this event should make the board re-read.
 *
 * An event with no `itemId` is not material *to the board*: it is a
 * settings change or another system-level row, and the board draws nothing
 * from it.
 */
export function isMaterial(event: LiveEvent): boolean {
  return event.itemId !== null && MATERIAL_TYPES.has(event.type);
}

/**
 * The ids of every card a slice of events touched, in first-seen order.
 *
 * Order is kept rather than returning a `Set` built any which way, because
 * this drives the change highlight and a stable order makes the behaviour
 * reproducible in a test.
 */
export function touchedItemIds(events: readonly LiveEvent[]): readonly string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (!isMaterial(event)) continue;
    const id = event.itemId;
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * The most recent `state_change` for `itemId` in this slice, or `null`.
 *
 * The *most recent* rather than the first: a slice can hold several moves of
 * the same card, and the one that explains where the card is now is the last
 * one. Events arrive ordered by `id` ascending (`readSinceBounded`), so the
 * last match wins.
 */
export function latestStateChange(events: readonly LiveEvent[], itemId: string): LiveEvent | null {
  let found: LiveEvent | null = null;
  for (const event of events) {
    if (event.type === "state_change" && event.itemId === itemId) found = event;
  }
  return found;
}

/** The `to` state a `state_change` reports, or `null` when the payload does not say. */
export function stateChangeTo(event: LiveEvent): string | null {
  const to = event.payload?.to;
  return typeof to === "string" && to !== "" ? to : null;
}

/**
 * Who to credit for an event, as a display name.
 *
 * **`system` is credited as "The system", not as its id**, because a system
 * event has `actorId: null` by construction (`EventActor` requires it) and
 * "null moved this" is not a sentence. Any other actor is named by its id,
 * which on this board is already a readable name (`ope`, `bunmi-4c7`) rather
 * than a UUID — see the crew roster. There is deliberately no lookup here:
 * a second request to resolve a name would make a refusal message wait on
 * the network, and the id is what every other surface in this app shows.
 */
export function actorName(event: LiveEvent): string {
  if (event.actorType === "system") return "The system";
  const id = event.actorId;
  return id !== null && id.trim() !== "" ? id : "Someone else";
}

/**
 * How long ago an event happened, at seconds precision near zero.
 *
 * **Separate from `relativeTime` in `@/lib/projects/view` on purpose.** That
 * one answers "just now" for anything under a minute, which is right for a
 * card's last-activity caption and wrong here: the whole point of a conflict
 * message is that the other move was *seconds* ago, and "Bunmi moved this to
 * In Review just now" loses exactly the fact that makes the refusal make
 * sense. Above a minute the two agree.
 *
 * Takes `now` rather than reading the clock, so every boundary is testable
 * without freezing time globally — the same reasoning that one gives.
 */
export function shortAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "moments ago";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
