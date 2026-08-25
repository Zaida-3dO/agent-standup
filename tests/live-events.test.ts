// What a live event means to the board — T17.
import { describe, expect, it } from "vitest";
import {
  actorName,
  isMaterial,
  latestStateChange,
  shortAgo,
  stateChangeTo,
  touchedItemIds,
  type LiveEvent,
} from "@/lib/live/events";

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: "1",
    itemId: "item-a",
    itemTitle: "A card",
    ts: "2026-08-25T12:00:00.000Z",
    type: "state_change",
    actorType: "agent",
    actorId: "bunmi-4c7",
    sessionId: "s-1",
    payload: { from: "executing", to: "in_review" },
    ...over,
  };
}

describe("isMaterial", () => {
  it("counts a state change", () => {
    expect(isMaterial(event())).toBe(true);
  });

  it("counts the other things a card draws", () => {
    for (const type of ["field_change", "claim", "release", "takeover", "merge", "review"]) {
      expect(isMaterial(event({ type }))).toBe(true);
    }
  });

  it("ignores progress writes that change nothing on a card", () => {
    // The reason this list is short: agents write notes and checkpoints
    // constantly, and refetching the board for each would be a full board
    // read several times a second.
    expect(isMaterial(event({ type: "note" }))).toBe(false);
    expect(isMaterial(event({ type: "checkpoint" }))).toBe(false);
    expect(isMaterial(event({ type: "nudge" }))).toBe(false);
  });

  it("ignores an event scoped to no item", () => {
    expect(isMaterial(event({ itemId: null, type: "setting_change" }))).toBe(false);
    // Even a type the board cares about is not material without an item.
    expect(isMaterial(event({ itemId: null, type: "state_change" }))).toBe(false);
  });
});

describe("touchedItemIds", () => {
  it("collects every changed card once, in first-seen order", () => {
    const ids = touchedItemIds([
      event({ id: "1", itemId: "item-a" }),
      event({ id: "2", itemId: "item-b" }),
      event({ id: "3", itemId: "item-a" }),
    ]);
    expect(ids).toEqual(["item-a", "item-b"]);
  });

  it("leaves out the events that do not matter", () => {
    const ids = touchedItemIds([
      event({ id: "1", itemId: "item-a", type: "note" }),
      event({ id: "2", itemId: "item-b", type: "state_change" }),
    ]);
    expect(ids).toEqual(["item-b"]);
  });

  it("is empty for an empty slice", () => {
    expect(touchedItemIds([])).toEqual([]);
  });
});

describe("latestStateChange", () => {
  it("returns the most recent move of that card, not the first", () => {
    // A slice can hold several moves; the one that explains where the card is
    // now is the last. Events arrive ordered by id ascending.
    const found = latestStateChange(
      [
        event({ id: "1", payload: { from: "on_deck", to: "executing" } }),
        event({ id: "2", payload: { from: "executing", to: "in_review" } }),
      ],
      "item-a",
    );
    expect(found?.id).toBe("2");
    expect(stateChangeTo(found!)).toBe("in_review");
  });

  it("ignores moves of a different card", () => {
    const found = latestStateChange([event({ itemId: "item-b" })], "item-a");
    expect(found).toBeNull();
  });

  it("ignores events that are not state changes", () => {
    expect(latestStateChange([event({ type: "claim" })], "item-a")).toBeNull();
  });
});

describe("stateChangeTo", () => {
  it("reads the payload's `to`", () => {
    expect(stateChangeTo(event())).toBe("in_review");
  });

  it("is null when the payload does not say — a slim read carries none", () => {
    expect(stateChangeTo(event({ payload: undefined }))).toBeNull();
    expect(stateChangeTo(event({ payload: null }))).toBeNull();
    expect(stateChangeTo(event({ payload: {} }))).toBeNull();
    expect(stateChangeTo(event({ payload: { to: 3 } }))).toBeNull();
    expect(stateChangeTo(event({ payload: { to: "" } }))).toBeNull();
  });
});

describe("actorName", () => {
  it("names an agent by its id", () => {
    expect(actorName(event({ actorType: "agent", actorId: "bunmi-4c7" }))).toBe("bunmi-4c7");
  });

  it("names a person by their id", () => {
    expect(actorName(event({ actorType: "person", actorId: "ope" }))).toBe("ope");
  });

  it("credits the system rather than rendering its null id", () => {
    // A system event has `actorId: null` by construction, and "null moved
    // this" is not a sentence.
    expect(actorName(event({ actorType: "system", actorId: null }))).toBe("The system");
  });

  it("falls back rather than naming an empty actor", () => {
    expect(actorName(event({ actorType: "agent", actorId: null }))).toBe("Someone else");
    expect(actorName(event({ actorType: "agent", actorId: "   " }))).toBe("Someone else");
  });
});

describe("shortAgo", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");

  it("keeps seconds, which is the whole point of the conflict message", () => {
    // "just now" would lose the fact that makes a refusal make sense.
    expect(shortAgo("2026-08-25T11:59:48.000Z", now)).toBe("12s ago");
  });

  it("says just now only for the same instant", () => {
    expect(shortAgo("2026-08-25T12:00:00.000Z", now)).toBe("just now");
  });

  it("steps up through minutes, hours and days", () => {
    expect(shortAgo("2026-08-25T11:58:00.000Z", now)).toBe("2m ago");
    expect(shortAgo("2026-08-25T09:00:00.000Z", now)).toBe("3h ago");
    expect(shortAgo("2026-08-23T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("never reports a future timestamp as negative", () => {
    expect(shortAgo("2026-08-25T12:00:30.000Z", now)).toBe("just now");
  });

  it("degrades rather than rendering Invalid Date", () => {
    expect(shortAgo("not a date", now)).toBe("moments ago");
  });
});
