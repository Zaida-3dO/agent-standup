// The "since your last visit" display derivations — MILESTONES.md #38.
//
// Plain functions over plain data, so this repo's DOM-free harness
// (`vitest.config.ts`: `environment: "node"`) can exercise them directly
// rather than only through a rendered component — the same split
// `src/lib/board/view.ts` follows. The components under
// `src/components/since/` are the thin presentational layer over these.
//
// **This module derives nothing the API already derived.** Whether an event
// is seen is the server's answer (`events LEFT JOIN event_seen` for the
// current profile — SCHEMA.md §8b); the client reads `event.seen` and never
// recomputes it. What is genuinely client-side is everything below: how an
// event reads as a sentence, how it groups under a heading, and what the
// empty and first-visit states say.
import type { SinceEvent, SinceFeed } from "./types";

/** An empty feed — the initial render state, and the shape a test starts from. */
export function emptyFeed(): SinceFeed {
  return { events: [], cursor: "0", horizon: "0", unseenCount: 0, firstVisit: false };
}

/**
 * What the page says when there is nothing to show, which is **three
 * different situations wearing the same empty list** — and telling them
 * apart is most of this feature's usefulness.
 *
 *   - **A first visit.** No read state at all, and no events either: a
 *     genuinely new installation. "Nothing has happened yet" is true and
 *     reassuring; "you're all caught up" would imply they had missed
 *     something and dealt with it.
 *   - **Caught up.** Events exist and this profile has seen all of them.
 *     This is the success state and should read like one.
 *   - **Nothing new since last visit.** The `unseenOnly` view with
 *     everything already marked. Same words as caught-up, deliberately —
 *     from where the reader sits these are the same fact, and inventing a
 *     distinction they cannot act on is noise.
 *
 * Returning `null` when the feed is *not* empty is what keeps a component
 * from having to ask "should I show the empty state?" separately from
 * "what does it say?" — one call answers both.
 */
export function emptyStateMessage(feed: SinceFeed): string | null {
  if (feed.events.length > 0) return null;
  if (feed.firstVisit) return "Nothing has happened yet.";
  return "You're all caught up.";
}

/**
 * The one-line summary of what an event was.
 *
 * Prose, not a type name: "since your last visit" is read by a person
 * catching up, and `dispatch_claimed` is not a sentence. Types the payload
 * gives something specific to say get a specific line; everything else
 * falls back to the type with its underscores opened up, which is the same
 * treatment `ItemCard` gives a state and degrades honestly rather than
 * hiding an event this function has not been taught about.
 *
 * **An unrecognised type is still shown.** Dropping it would make the
 * ledger silently incomplete for the reader, which is the one thing a
 * catch-up view must not do.
 */
export function eventSummary(event: SinceEvent): string {
  const payload = event.payload;
  switch (event.type) {
    case "state_change": {
      const from = typeof payload.from === "string" ? payload.from : null;
      const to = typeof payload.to === "string" ? payload.to : null;
      if (from && to) return `moved from ${humanise(from)} to ${humanise(to)}`;
      if (to) return `moved to ${humanise(to)}`;
      return "changed state";
    }
    case "field_change": {
      const field = typeof payload.field === "string" ? payload.field : null;
      return field ? `${humanise(field)} changed` : "a field changed";
    }
    case "note":
      return "left a note";
    case "checkpoint":
      return "recorded a checkpoint";
    case "claim":
      return "claimed it";
    case "release":
      return "released it";
    case "takeover":
      return "took it over";
    case "review_requested":
      return "asked for review";
    case "review":
      return "reviewed it";
    case "merge":
      return "merged it";
    case "escalation":
      return "escalated it";
    case "nudge":
      return "was nudged";
    default:
      return humanise(event.type);
  }
}

/** `plan_review` → `plan review`. Shared by the summary lines above. */
function humanise(value: string): string {
  return value.replace(/_/g, " ");
}

/**
 * Who did it, as a name to show — never a raw identifier where a better one
 * exists, and never an empty string.
 *
 * `system` deliberately ignores any `actorId`: a system event is the
 * application acting on its own, and showing an internal identifier beside
 * it invites a reader to think a person or agent was involved.
 */
export function actorLabel(event: SinceEvent): string {
  if (event.actorType === "system") return "System";
  return event.actorId ?? (event.actorType === "agent" ? "An agent" : "Someone");
}

/**
 * The events grouped under the item they happened to, in the order those
 * items first appear.
 *
 * Grouping is the whole reason this view beats reading the raw ledger: six
 * `field_change` rows on one item is one thing that happened to one piece
 * of work, and a flat list makes it look like six. Items that are not
 * scoped to an item at all (`setting_change`, whose `item_id` is null per
 * SCHEMA.md §3) group under a `null` key rather than being dropped — they
 * are real changes a reader wants to know about.
 *
 * Insertion order rather than sorted: the caller has already ordered the
 * feed, and re-sorting here would silently override whatever it chose.
 */
export interface SinceGroup {
  readonly itemId: string | null;
  readonly itemTitle: string | null;
  readonly events: readonly SinceEvent[];
  /** How many in this group this profile has not seen — what the group's badge shows. */
  readonly unseenCount: number;
}

export function groupByItem(events: readonly SinceEvent[]): SinceGroup[] {
  const order: (string | null)[] = [];
  const byItem = new Map<string | null, SinceEvent[]>();
  for (const event of events) {
    const key = event.itemId;
    if (!byItem.has(key)) {
      byItem.set(key, []);
      order.push(key);
    }
    byItem.get(key)!.push(event);
  }
  return order.map((itemId) => {
    const groupEvents = byItem.get(itemId)!;
    return {
      itemId,
      // The title from whichever event in the group carries one — they all
      // describe the same item, but a null is possible per event, and
      // taking the first non-null is more robust than trusting `[0]`.
      itemTitle: groupEvents.find((event) => event.itemTitle !== null)?.itemTitle ?? null,
      events: groupEvents,
      unseenCount: groupEvents.reduce((count, event) => (event.seen ? count : count + 1), 0),
    };
  });
}

/**
 * The ids the "mark all as seen" action should send.
 *
 * **Only the unseen ones.** The write is idempotent, so including the rest
 * would be harmless to correctness — but it would be a request that grows
 * with history rather than with what is actually new, and it would rewrite
 * nothing while looking like it did. The honest request is the one that
 * names exactly the rows that will change.
 */
export function unseenEventIds(events: readonly SinceEvent[]): string[] {
  return events.filter((event) => !event.seen).map((event) => event.id);
}
