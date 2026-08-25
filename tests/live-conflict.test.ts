// Conflict handling when two agents touch one item — T17, part 2.
//
// The row's criterion is "a conflict names who moved it, to where, and when",
// so these assert all three, and — just as importantly — assert that each one
// degrades to something truthful when the ledger cannot supply it. A conflict
// message that invented an actor would be worse than the generic refusal,
// because it would be confidently wrong.
import { describe, expect, it } from "vitest";
import { conflictDetailsFrom, conflictMessage } from "@/lib/live/conflict";
import type { LiveEvent } from "@/lib/live/events";

function event(over: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: "1",
    itemId: "item-a",
    itemTitle: "A card",
    ts: "2026-08-25T11:59:48.000Z",
    type: "state_change",
    actorType: "agent",
    actorId: "bunmi-4c7",
    sessionId: "s-1",
    payload: { from: "executing", to: "in_review" },
    ...over,
  };
}

const NOW = Date.parse("2026-08-25T12:00:00.000Z");

describe("conflictDetailsFrom", () => {
  it("reads the state the server says the item is actually in", () => {
    // `StaleTransitionError` puts it in `details.currentState` precisely so a
    // client does not have to parse prose to learn where the item really is.
    const details = conflictDetailsFrom({
      error: {
        message: "item-a is in in_review, not executing.",
        details: { itemId: "item-a", expectedFrom: "executing", currentState: "in_review" },
      },
    });
    expect(details).toEqual({ currentState: "in_review", expectedFrom: "executing" });
  });

  it("returns null for a 409 whose details cannot be read", () => {
    // Falls back to the generic refusal rather than naming a state it did
    // not actually read.
    expect(conflictDetailsFrom({ error: { message: "nope" } })).toBeNull();
    expect(conflictDetailsFrom({ error: { details: {} } })).toBeNull();
    expect(conflictDetailsFrom({ error: { details: { currentState: "" } } })).toBeNull();
    expect(conflictDetailsFrom({ error: { details: { currentState: 3 } } })).toBeNull();
  });

  it("returns null for anything that is not an error envelope at all", () => {
    expect(conflictDetailsFrom(null)).toBeNull();
    expect(conflictDetailsFrom(undefined)).toBeNull();
    expect(conflictDetailsFrom("a string")).toBeNull();
    expect(conflictDetailsFrom({})).toBeNull();
    expect(conflictDetailsFrom({ error: null })).toBeNull();
  });

  it("keeps the current state when expectedFrom is missing", () => {
    const details = conflictDetailsFrom({ error: { details: { currentState: "merged" } } });
    expect(details).toEqual({ currentState: "merged", expectedFrom: null });
  });
});

describe("conflictMessage", () => {
  it("names who moved it, where to, and how long ago", () => {
    const message = conflictMessage(
      { currentState: "in_review", expectedFrom: "executing" },
      [event()],
      "item-a",
      NOW,
    );
    expect(message).toBe("bunmi-4c7 moved this to in review 12s ago. The board has been updated.");
  });

  it("still says where the item is when the ledger cannot attribute it", () => {
    // No extra request is made to build this message, so the attribution is
    // best-effort — but the state is not, because that is what makes the
    // refusal actionable.
    const message = conflictMessage(
      { currentState: "in_review", expectedFrom: "executing" },
      [],
      "item-a",
      NOW,
    );
    expect(message).toContain("in review");
    expect(message).not.toContain("undefined");
    expect(message).not.toContain("null");
  });

  it("never credits a move of a different card", () => {
    const message = conflictMessage(
      { currentState: "in_review", expectedFrom: "executing" },
      [event({ itemId: "item-b" })],
      "item-a",
      NOW,
    );
    expect(message).not.toContain("bunmi-4c7");
  });

  it("prefers the server's current state over the event's, when they disagree", () => {
    // The 409 is the newer fact. A message naming a state the item has
    // already left would send the reader looking in the wrong column.
    const message = conflictMessage(
      { currentState: "merged", expectedFrom: "executing" },
      [event({ payload: { from: "executing", to: "in_review" } })],
      "item-a",
      NOW,
    );
    expect(message).toContain("merged");
    expect(message).not.toContain("in review");
  });

  it("credits the system without rendering a null id", () => {
    const message = conflictMessage(
      { currentState: "merged", expectedFrom: "executing" },
      [event({ actorType: "system", actorId: null })],
      "item-a",
      NOW,
    );
    expect(message).toBe("The system moved this to merged 12s ago. The board has been updated.");
  });

  it("humanises the state rather than showing the raw value", () => {
    const message = conflictMessage(
      { currentState: "plan_review", expectedFrom: "planning" },
      [],
      "item-a",
      NOW,
    );
    expect(message).toContain("plan review");
    expect(message).not.toContain("plan_review");
  });
});
