// The shape the "since your last visit" view renders — MILESTONES.md #38,
// over the `GET /events` response.
//
// Deliberately its own types rather than imports from `@/lib/service`, for
// exactly the reason `@/lib/board/types.ts` and `@/lib/profile/types.ts`
// give: the front end reaches the service layer only through the adapter's
// JSON, never its modules. Importing `GetEventsOutput` here would couple
// every component to how the operation that produces it happens to be
// typed, and — the sharper problem — put a module that transitively imports
// the database client's types onto the client bundle's import graph, which
// is what `npm run check:db-imports` exists to prevent.

/** The event vocabulary, as the API sends it (SCHEMA.md §3). */
export type SinceEventType =
  | "field_change"
  | "state_change"
  | "claim"
  | "release"
  | "takeover"
  | "review_requested"
  | "review"
  | "merge"
  | "dispatch"
  | "dispatch_claimed"
  | "checkpoint"
  | "nudge"
  | "escalation"
  | "note"
  | "setting_change"
  | "open_loop"
  | "open_loop_closed"
  | "open_loop_edited"
  | "open_loop_deleted";

/**
 * One event, with the current profile's read state already resolved against
 * it by the server.
 *
 * **`payload` and `body` are optional, not always present.** `GET /events`
 * returns the slim shape by default — id, itemId, itemTitle, ts, actorType,
 * actorId, type and seen state, which is what a "what's new" line needs —
 * and only carries `payload`/`body` when the caller asked with `full: true`
 * (`FetchFeedOptions.full`, `state.ts`). A component reading `event.body`
 * or `event.payload` without checking for `undefined` first would be
 * assuming a shape the server only sometimes sends.
 */
export interface SinceEvent {
  /** A stringified `bigint` — never a number. See the operation's `since` field for why. */
  readonly id: string;
  readonly itemId: string | null;
  readonly itemTitle: string | null;
  /** ISO 8601. */
  readonly ts: string;
  readonly actorType: "person" | "agent" | "system";
  readonly actorId: string | null;
  readonly type: string;
  /** Present only when the request that produced this feed asked for `full: true`. */
  readonly payload?: Record<string, unknown>;
  /** Present only when the request that produced this feed asked for `full: true`. */
  readonly body?: string | null;
  /** Whether **this** profile has marked it seen. */
  readonly seen: boolean;
  /** Whether any profile has — distinct from `seen`, see the operation's header. */
  readonly seenByAnyone: boolean;
}

/** The whole `GET /events` response. */
export interface SinceFeed {
  readonly events: readonly SinceEvent[];
  readonly cursor: string;
  readonly horizon: string;
  readonly unseenCount: number;
  /** True when this profile has never marked anything seen — the first visit. */
  readonly firstVisit: boolean;
}
