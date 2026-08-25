// The suspension arithmetic, called directly.
//
// This is the pure layer beneath `tests/undo-toast-overlay-suppression.test.ts`.
// The composition test proves the toast and the palette agree; this proves the
// numbers are right, in the harness where a clock is a parameter rather than
// something to wait for. Both layers are needed: the review that led to this
// row was explicit that a green pure suite is exactly what let two composition
// defects ship.
import { describe, expect, it } from "vitest";
import {
  NO_SUSPENSION,
  UNDO_WINDOW_MS,
  isWithinWindow,
  remainingMs,
  resumed,
  suspended,
  suspendedMs,
  windowClock,
  type UndoableAction,
} from "@/lib/undo";

const T0 = 1_000_000;

function anAction(at: number): UndoableAction {
  return {
    kind: "state-change",
    at,
    move: { itemId: "item-a", from: "on_deck", to: "executing" },
    itemTitle: "A card",
  };
}

describe("suspendedMs", () => {
  it("is zero for a suspension that has never started", () => {
    expect(suspendedMs(NO_SUSPENSION, T0)).toBe(0);
  });

  it("counts an interval that is still open, as of the instant asked about", () => {
    const open = suspended(NO_SUSPENSION, T0);
    expect(suspendedMs(open, T0 + 3_000)).toBe(3_000);
    // The same value re-read later has grown, without anything having been
    // written — this is why the open interval is stored rather than folded in.
    expect(suspendedMs(open, T0 + 9_000)).toBe(9_000);
  });

  it("adds a closed interval to a later open one", () => {
    const first = resumed(suspended(NO_SUSPENSION, T0), T0 + 2_000);
    const second = suspended(first, T0 + 5_000);
    expect(suspendedMs(second, T0 + 6_500)).toBe(3_500);
  });
});

describe("suspended", () => {
  it("starts the interval when nothing was suspended", () => {
    expect(suspended(NO_SUSPENSION, T0).since).toBe(T0);
  });

  it("does not restart an interval that is already open", () => {
    // The idempotence that matters: a re-render reporting the same fact, or a
    // second overlay opening over the first, must not discard elapsed time.
    // Restarting here would reset `since` to the later instant and silently
    // hand back the seconds already frozen.
    const open = suspended(NO_SUSPENSION, T0);
    const again = suspended(open, T0 + 4_000);
    expect(again.since).toBe(T0);
    expect(suspendedMs(again, T0 + 4_000)).toBe(4_000);
  });
});

describe("resumed", () => {
  it("banks the open interval and clears it", () => {
    const banked = resumed(suspended(NO_SUSPENSION, T0), T0 + 2_500);
    expect(banked).toEqual({ accumulatedMs: 2_500, since: null });
  });

  it("is a no-op when nothing was suspended", () => {
    expect(resumed(NO_SUSPENSION, T0)).toBe(NO_SUSPENSION);
  });

  it("banks zero rather than a negative when the clock stepped backwards", () => {
    // A negative would SHORTEN the window and expire an offer early, which is
    // the failure `isWithinWindow` refuses to have for the same reason. The
    // person's clock is not their fault.
    const banked = resumed(suspended(NO_SUSPENSION, T0), T0 - 5_000);
    expect(banked.accumulatedMs).toBe(0);
  });
});

describe("windowClock", () => {
  it("is the wall clock when nothing has been suspended", () => {
    expect(windowClock(T0, NO_SUSPENSION)).toBe(T0);
  });

  it("rewinds the clock by the time the window could not be spent", () => {
    const banked = resumed(suspended(NO_SUSPENSION, T0), T0 + 4_000);
    expect(windowClock(T0 + 10_000, banked)).toBe(T0 + 6_000);
  });

  it("keeps an offer live across a suspension longer than the whole window", () => {
    // The behaviour the fix exists for, as arithmetic: an action offered at
    // T0, suspended almost immediately, and released a full minute later is
    // still inside its window — with nearly all of it left.
    const action = anAction(T0);
    const held = resumed(suspended(NO_SUSPENSION, T0 + 1_000), T0 + 61_000);
    const at = windowClock(T0 + 61_000, held);

    expect(isWithinWindow(action, at)).toBe(true);
    expect(remainingMs(action, at)).toBe(UNDO_WINDOW_MS - 1_000);
    // And without the correction it would be long gone, which is the whole
    // point of the correction.
    expect(isWithinWindow(action, T0 + 61_000)).toBe(false);
  });

  it("resumes the clock after a suspension rather than freezing it forever", () => {
    // The survivor this was written for: an implementation that returned the
    // open `since` whenever one had ever been set would keep every test above
    // green while making a once-suspended offer immortal. After `resumed`,
    // `windowClock` must advance with the wall clock again.
    const banked = resumed(suspended(NO_SUSPENSION, T0), T0 + 2_000);
    expect(windowClock(T0 + 2_000, banked)).toBe(T0);
    expect(windowClock(T0 + 5_000, banked)).toBe(T0 + 3_000);
    // Two different instants must give two different answers — a frozen
    // clock returns the same number for both.
    expect(windowClock(T0 + 5_000, banked)).not.toBe(windowClock(T0 + 2_000, banked));
  });

  it("still expires an offer once its unsuspended time runs out", () => {
    // Pausing must not become never-expiring. Two seconds frozen, then the
    // window genuinely runs out.
    const action = anAction(T0);
    const held = resumed(suspended(NO_SUSPENSION, T0 + 1_000), T0 + 3_000);
    const at = windowClock(T0 + 3_000 + UNDO_WINDOW_MS, held);

    expect(isWithinWindow(action, at)).toBe(false);
    expect(remainingMs(action, at)).toBe(0);
  });
});
