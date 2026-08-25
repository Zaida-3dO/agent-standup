// What a screen reader is told during a drag — T6-A and T6-B.
//
// These sentences ARE the keyboard interaction for anyone not looking at
// the board: a keyboard move that announced nothing would be a gesture
// performed blind. So they are asserted as strings, not as "contains a
// word".
import { describe, expect, it } from "vitest";
import {
  cancelledMessage,
  droppedMessage,
  movedOverMessage,
  pickedUpMessage,
} from "@/lib/board/drag-announce";
import { columnTitle } from "@/lib/board/view";

describe("pickedUpMessage", () => {
  it("names the card and the column it started in", () => {
    const message = pickedUpMessage("Fix the drag", "backlog");
    expect(message).toContain("Fix the drag");
    // The column the reader is moving FROM — every later message is
    // relative to it.
    expect(message).toContain(columnTitle("backlog"));
  });

  it("says how to move, drop and cancel, because nothing else will", () => {
    // A keyboard drag has no visible affordance saying which keys work. If
    // this sentence does not carry the instructions, nothing does.
    const message = pickedUpMessage("An item", "in_progress");
    expect(message).toMatch(/arrow keys/i);
    expect(message).toMatch(/space or enter/i);
    expect(message).toMatch(/escape/i);
  });
});

describe("movedOverMessage", () => {
  it("names the column the card is now over, and how to drop it there", () => {
    const message = movedOverMessage("An item", "completed");
    expect(message).toContain(columnTitle("completed"));
    expect(message).toMatch(/space or enter/i);
  });

  it("says outright that Waiting cannot take the card", () => {
    // Silence here would read as "this is fine", and the reader would only
    // find out otherwise by pressing space and having nothing happen.
    const message = movedOverMessage("An item", "waiting");
    expect(message).toMatch(/cannot accept/i);
  });

  it("does NOT offer the drop instruction on a column that would refuse it", () => {
    // The precise failure: telling someone to press space on a column that
    // will not take the card.
    expect(movedOverMessage("An item", "waiting")).not.toMatch(/press space/i);
  });

  it("explains where a paused or blocked item IS set instead", () => {
    // A refusal that does not say what to do instead is a dead end.
    expect(movedOverMessage("An item", "waiting")).toMatch(/from the item/i);
  });
});

describe("droppedMessage", () => {
  it("confirms the card and where it landed", () => {
    const message = droppedMessage("Fix the drag", "in_progress");
    expect(message).toContain("Fix the drag");
    expect(message).toContain(columnTitle("in_progress"));
  });
});

describe("cancelledMessage", () => {
  it("says where the card went back to", () => {
    const message = cancelledMessage("An item", "backlog");
    expect(message).toMatch(/cancelled/i);
    expect(message).toContain(columnTitle("backlog"));
  });

  it("still says the card was not moved when the source is unknown", () => {
    // "Cancelled" alone leaves open whether anything happened to the card.
    const message = cancelledMessage("An item", null);
    expect(message).toMatch(/cancelled/i);
    expect(message).toMatch(/not moved/i);
  });
});
