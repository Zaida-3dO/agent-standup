// The focus trap's decision half — `@/lib/palette/focus-trap`.
//
// The row that asked for this is explicit that the trap belongs to the
// mounting container rather than to `QuickCreateDialog`, because the dialog
// is hook-free by design so the DOM-free harness can call it. The rule about
// WHICH element Tab should reach is the part that can be tested without a
// DOM at all, so it lives here as a function over a list and is tested over
// plain strings.
import { describe, expect, it } from "vitest";
import { FOCUSABLE_SELECTOR, nextTrapFocus } from "@/lib/palette/focus-trap";

const RING = ["first", "middle", "last"] as const;

describe("nextTrapFocus — the two ends of the cycle", () => {
  it("wraps forward from the last element to the first", () => {
    expect(nextTrapFocus(RING, "last", false)).toBe("first");
  });

  it("wraps backward from the first element to the last", () => {
    expect(nextTrapFocus(RING, "first", true)).toBe("last");
  });

  it("does NOT wrap forward from the first element", () => {
    // The distinction that makes this a trap rather than a loop that fires
    // on every press: in the middle of the cycle the browser is already
    // right, and overriding it would mean re-implementing focus order.
    expect(nextTrapFocus(RING, "first", false)).toBeNull();
  });

  it("does NOT wrap backward from the last element", () => {
    expect(nextTrapFocus(RING, "last", true)).toBeNull();
  });

  it("leaves the middle of the cycle to the browser in both directions", () => {
    expect(nextTrapFocus(RING, "middle", false)).toBeNull();
    expect(nextTrapFocus(RING, "middle", true)).toBeNull();
  });
});

describe("nextTrapFocus — focus outside the overlay", () => {
  it("pulls focus back in from outside, at the first element going forward", () => {
    // This is what makes it a trap. Without it, the very first Tab from a
    // dialog that opened without focusing anything would leave.
    expect(nextTrapFocus(RING, "somewhere-else", false)).toBe("first");
    expect(nextTrapFocus(RING, null, false)).toBe("first");
  });

  it("pulls focus back in at the last element going backward", () => {
    // Shift+Tab from outside should land at the END, not the start —
    // otherwise the direction the person is travelling is reversed.
    expect(nextTrapFocus(RING, "somewhere-else", true)).toBe("last");
    expect(nextTrapFocus(RING, null, true)).toBe("last");
  });
});

describe("nextTrapFocus — degenerate rings", () => {
  it("has nothing to say about an empty overlay", () => {
    expect(nextTrapFocus([], null, false)).toBeNull();
    expect(nextTrapFocus([], "x", true)).toBeNull();
  });

  it("keeps a single focusable element focused in both directions", () => {
    // First and last are the same element, so both ends wrap onto it.
    expect(nextTrapFocus(["only"], "only", false)).toBe("only");
    expect(nextTrapFocus(["only"], "only", true)).toBe("only");
  });
});

describe("FOCUSABLE_SELECTOR", () => {
  it("excludes disabled controls", () => {
    // Quick create's submit button is disabled until the draft is valid.
    // Including it would send Tab to an element the browser refuses to
    // focus, dropping focus to the body and escaping the trap on the very
    // first press.
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("input:not([disabled])");
    expect(FOCUSABLE_SELECTOR).toContain("select:not([disabled])");
  });

  it("excludes programmatically-focusable elements from the Tab ring", () => {
    // `tabindex="-1"` marks something reachable by script but not by Tab —
    // the palette's own option rows are exactly that.
    expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
    expect(FOCUSABLE_SELECTOR).not.toContain('[tabindex="-1"],');
  });

  it("covers the control types quick create actually renders", () => {
    // The dialog renders inputs, selects and buttons. A selector missing
    // any of them would leave a real field outside the trap.
    for (const tag of ["input", "select", "button", "textarea", "a[href]"]) {
      expect(FOCUSABLE_SELECTOR).toContain(tag);
    }
  });
});
