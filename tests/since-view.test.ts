// src/lib/since/view.ts — the "since your last visit" display derivations
// for MILESTONES.md #38: what an event reads as, how events group under the
// item they happened to, what the empty state says, and which ids a
// mark-all action should send.
//
// Pure functions over plain data, so these run with no DOM and no database.
import { describe, expect, it } from "vitest";
import {
  actorLabel,
  emptyFeed,
  emptyStateMessage,
  eventSummary,
  groupByItem,
  unseenEventIds,
} from "@/lib/since/view";
import type { SinceEvent, SinceFeed } from "@/lib/since/types";

function event(overrides: Partial<SinceEvent> = {}): SinceEvent {
  return {
    id: "1",
    itemId: "item-a",
    itemTitle: "Item A",
    ts: "2026-08-14T10:00:00.000Z",
    actorType: "agent",
    actorId: "builder-one",
    type: "note",
    payload: {},
    body: null,
    seen: false,
    seenByAnyone: false,
    ...overrides,
  };
}

function feed(overrides: Partial<SinceFeed> = {}): SinceFeed {
  return { ...emptyFeed(), ...overrides };
}

describe("emptyStateMessage — the three situations an empty list can mean", () => {
  it("says nothing has happened yet on a genuine first visit", () => {
    expect(emptyStateMessage(feed({ firstVisit: true }))).toBe("Nothing has happened yet.");
  });

  it("says you are caught up when the profile has read state but nothing is new", () => {
    // Not a first visit: this person has marked things seen before, so an
    // empty list means they cleared it, not that the system is new.
    expect(emptyStateMessage(feed({ firstVisit: false }))).toBe("You're all caught up.");
  });

  it("returns null — not a message — when there is anything to show", () => {
    // The whole point of returning null: a component asks once, and gets
    // both "should I show an empty state" and "what does it say".
    expect(emptyStateMessage(feed({ events: [event()] }))).toBeNull();
  });

  it("shows the list rather than a first-visit message when a first visitor has events", () => {
    // A first visitor with events must see them — this is the boundary the
    // whole design turns on. `firstVisit: true` must not suppress a
    // non-empty list.
    expect(emptyStateMessage(feed({ events: [event()], firstVisit: true }))).toBeNull();
  });
});

describe("eventSummary — an event as a sentence, not a type name", () => {
  it("names both ends of a state change", () => {
    expect(
      eventSummary(event({ type: "state_change", payload: { from: "on_deck", to: "executing" } })),
    ).toBe("moved from on deck to executing");
  });

  it("names just the destination when the payload has no from", () => {
    expect(eventSummary(event({ type: "state_change", payload: { to: "merged" } }))).toBe(
      "moved to merged",
    );
  });

  it("falls back to a bare phrase when a state change carries neither end", () => {
    expect(eventSummary(event({ type: "state_change", payload: {} }))).toBe("changed state");
  });

  it("ignores a non-string from/to rather than rendering an object into the sentence", () => {
    // The payload is `Json` — nothing in the type system stops a malformed
    // row, and "moved to [object Object]" is worse than the generic line.
    expect(eventSummary(event({ type: "state_change", payload: { from: 1, to: { a: 1 } } }))).toBe(
      "changed state",
    );
  });

  it("names the field a field_change touched", () => {
    expect(
      eventSummary(event({ type: "field_change", payload: { field: "merge_authority" } })),
    ).toBe("merge authority changed");
  });

  it("has a specific line for each of the plain event types", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["note", "left a note"],
      ["checkpoint", "recorded a checkpoint"],
      ["claim", "claimed it"],
      ["release", "released it"],
      ["takeover", "took it over"],
      ["review_requested", "asked for review"],
      ["review", "reviewed it"],
      ["merge", "merged it"],
      ["escalation", "escalated it"],
      ["nudge", "was nudged"],
    ];
    for (const [type, expected] of cases) {
      expect(eventSummary(event({ type }))).toBe(expected);
    }
  });

  it("still shows an event type it has never been taught about", () => {
    // Dropping an unrecognised event would make the catch-up view silently
    // incomplete, which is the one thing it must not be.
    expect(eventSummary(event({ type: "some_future_type" }))).toBe("some future type");
  });
});

describe("actorLabel", () => {
  it("uses the actor id for a person or an agent", () => {
    expect(actorLabel(event({ actorType: "agent", actorId: "builder-one" }))).toBe("builder-one");
    expect(actorLabel(event({ actorType: "person", actorId: "user-a" }))).toBe("user-a");
  });

  it("says System for a system event and ignores any id it carries", () => {
    // Showing an internal identifier beside a system event invites the
    // reader to think a person was involved.
    expect(actorLabel(event({ actorType: "system", actorId: "internal-7" }))).toBe("System");
  });

  it("never renders an empty label when an actor id is missing", () => {
    expect(actorLabel(event({ actorType: "agent", actorId: null }))).toBe("An agent");
    expect(actorLabel(event({ actorType: "person", actorId: null }))).toBe("Someone");
  });
});

describe("groupByItem", () => {
  it("collects an item's events into one group instead of a flat list", () => {
    const groups = groupByItem([
      event({ id: "1", itemId: "a" }),
      event({ id: "2", itemId: "a" }),
      event({ id: "3", itemId: "a" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.events.map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  it("keeps the order items first appear in, rather than re-sorting", () => {
    const groups = groupByItem([
      event({ id: "1", itemId: "b" }),
      event({ id: "2", itemId: "a" }),
      event({ id: "3", itemId: "b" }),
    ]);
    expect(groups.map((g) => g.itemId)).toEqual(["b", "a"]);
    // And the interleaved event still lands in its own group, not a third one.
    expect(groups[0]!.events.map((e) => e.id)).toEqual(["1", "3"]);
  });

  it("keeps events with no item under their own group rather than dropping them", () => {
    // `setting_change` has a null item_id (SCHEMA.md §3) and is a real
    // change a reader wants to know about.
    const groups = groupByItem([
      event({ id: "1", itemId: null, itemTitle: null, type: "setting_change" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.itemId).toBeNull();
  });

  it("counts only the unseen events in each group", () => {
    const groups = groupByItem([
      event({ id: "1", itemId: "a", seen: true }),
      event({ id: "2", itemId: "a", seen: false }),
      event({ id: "3", itemId: "a", seen: false }),
    ]);
    expect(groups[0]!.unseenCount).toBe(2);
  });

  it("reports zero unseen for a group that is entirely seen", () => {
    const groups = groupByItem([event({ id: "1", itemId: "a", seen: true })]);
    expect(groups[0]!.unseenCount).toBe(0);
  });

  it("takes the title from whichever event carries one", () => {
    // A null title on the first event must not blank the whole group's heading.
    const groups = groupByItem([
      event({ id: "1", itemId: "a", itemTitle: null }),
      event({ id: "2", itemId: "a", itemTitle: "The real title" }),
    ]);
    expect(groups[0]!.itemTitle).toBe("The real title");
  });

  it("returns no groups for no events", () => {
    expect(groupByItem([])).toEqual([]);
  });
});

describe("unseenEventIds — what a mark-all action actually sends", () => {
  it("names only the unseen events", () => {
    expect(
      unseenEventIds([
        event({ id: "1", seen: true }),
        event({ id: "2", seen: false }),
        event({ id: "3", seen: true }),
        event({ id: "4", seen: false }),
      ]),
    ).toEqual(["2", "4"]);
  });

  it("sends nothing when everything is already seen", () => {
    expect(unseenEventIds([event({ id: "1", seen: true })])).toEqual([]);
  });

  it("sends everything on a first visit, where nothing has been seen", () => {
    expect(unseenEventIds([event({ id: "1" }), event({ id: "2" })])).toEqual(["1", "2"]);
  });
});

describe("emptyFeed", () => {
  it("is empty, uncounted, and not a first visit", () => {
    const initial = emptyFeed();
    expect(initial.events).toEqual([]);
    expect(initial.unseenCount).toBe(0);
    // False rather than true: the initial render state is "we have not
    // asked yet", and claiming a first visit before the server has
    // answered would flash "nothing has happened yet" at someone with a
    // full inbox.
    expect(initial.firstVisit).toBe(false);
  });
});
