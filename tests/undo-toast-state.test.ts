// The toast's state transitions — T18.
//
// These are the rules that keep the affordance honest under the awkward
// timings a time-limited button invites: a double press, a press landing
// on the tick the window closes, a slow response arriving after the person
// has moved on. Each is a plain function call here, with the clock as a
// parameter, so none of them needs a timer to test.
import { describe, expect, it } from "vitest";
import {
  UNDO_WINDOW_MS,
  actionOffered,
  idleToast,
  ticked,
  undoPressed,
  undoSettled,
  type UndoToastState,
  type UndoableAction,
} from "@/lib/undo";

const anAction: UndoableAction = {
  kind: "state-change",
  at: 1_000,
  move: { itemId: "item-1", from: "executing", to: "in_review" },
  itemTitle: "Wire the thing",
};

const anArchive: UndoableAction = {
  kind: "archive",
  at: 1_000,
  itemId: "item-1",
  itemTitle: "A duplicate",
};

const offered = actionOffered(anAction);

describe("offering an action", () => {
  it("shows it", () => {
    expect(offered.phase).toBe("offered");
    if (offered.phase !== "offered") return;
    expect(offered.action).toBe(anAction);
  });

  it("takes over the toast, including from an in-flight undo", () => {
    // One toast at a time: two time-limited buttons with different
    // expiries on screen at once is the thing this rules out.
    const undoing = undoPressed(offered, 1_000);
    const next = actionOffered(anArchive);
    expect(undoing.phase).toBe("undoing");
    expect(next.phase).toBe("offered");
    if (next.phase !== "offered") return;
    expect(next.action).toBe(anArchive);
  });
});

describe("pressing undo", () => {
  it("moves an offered, still-live action into flight", () => {
    const next = undoPressed(offered, 1_000 + 5_000);
    expect(next.phase).toBe("undoing");
  });

  it("ignores a second press", () => {
    // A double press must not send a second set of transitions. Identity
    // is asserted, not just the phase: returning a NEW `undoing` state
    // would let the host fire another request.
    const first = undoPressed(offered, 1_000);
    const second = undoPressed(first, 1_000);
    expect(second).toBe(first);
  });

  it("ignores a press that lands on the tick the window closes", () => {
    const next = undoPressed(offered, 1_000 + UNDO_WINDOW_MS);
    expect(next).toBe(offered);
    expect(next.phase).toBe("offered");
  });

  it("ignores a press on an action with no inverse", () => {
    // An archive is offered (the confirmation is worth showing) but must
    // never send anything.
    const archiveOffered = actionOffered(anArchive);
    expect(undoPressed(archiveOffered, 1_000)).toBe(archiveOffered);
  });

  it("does nothing from idle", () => {
    expect(undoPressed(idleToast, 1_000)).toBe(idleToast);
  });
});

describe("the clock advancing", () => {
  it("leaves a live offer alone", () => {
    const next = ticked(offered, 1_000 + UNDO_WINDOW_MS - 1);
    expect(next).toBe(offered);
  });

  it("clears an expired offer", () => {
    const next = ticked(offered, 1_000 + UNDO_WINDOW_MS);
    expect(next.phase).toBe("idle");
  });

  it("does not expire an undo already in flight", () => {
    // The request is sent; pulling the toast would leave the person with
    // no report of a write they asked for.
    const undoing = undoPressed(offered, 1_000);
    expect(ticked(undoing, 1_000 + UNDO_WINDOW_MS + 60_000)).toBe(undoing);
  });

  it("does not expire a settled report", () => {
    // An explanation that vanishes on a timer is one the person may never
    // have read.
    const error: UndoToastState = { phase: "error", kind: "stale", message: "Someone else…" };
    expect(ticked(error, 1_000 + UNDO_WINDOW_MS + 60_000)).toBe(error);
    const done: UndoToastState = { phase: "undone" };
    expect(ticked(done, 1_000 + UNDO_WINDOW_MS + 60_000)).toBe(done);
  });
});

describe("settling", () => {
  const undoing = undoPressed(offered, 1_000);

  it("reports success", () => {
    expect(undoSettled(undoing, { ok: true }).phase).toBe("undone");
  });

  it("carries a stale refusal through with its kind and message intact", () => {
    const next = undoSettled(undoing, {
      ok: false,
      kind: "stale",
      message: "Someone else moved this — it is now in merged, so the undo was not applied.",
    });
    expect(next.phase).toBe("error");
    if (next.phase !== "error") return;
    // The kind survives to the surface — this is what lets the toast treat
    // a conflict differently from a failure.
    expect(next.kind).toBe("stale");
    expect(next.message).toContain("merged");
  });

  it("distinguishes an ordinary failure from staleness", () => {
    const next = undoSettled(undoing, { ok: false, kind: "failed", message: "It broke." });
    expect(next.phase).toBe("error");
    if (next.phase !== "error") return;
    expect(next.kind).toBe("failed");
  });

  it("cannot settle a toast that is not undoing", () => {
    // A response arriving after the person did something else must not
    // overwrite the newer toast with a report about a vanished one.
    expect(undoSettled(offered, { ok: true })).toBe(offered);
    expect(undoSettled(idleToast, { ok: true })).toBe(idleToast);
  });
});
