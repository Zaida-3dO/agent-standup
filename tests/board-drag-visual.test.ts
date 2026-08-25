// The visual rules of a pointer drag — T6-A.
//
// Pure functions over plain data, so no DOM and no `dnd-kit` is involved in
// proving any of this. What the library does with these values is wiring;
// what the values ARE is the behaviour, and it is decided here.
import { describe, expect, it } from "vitest";
import {
  DRAG_LIFT_SCALE,
  DRAG_TILT_DEG,
  MOTION_MS,
  dragTransform,
  isDropZone,
  placeholderColumn,
} from "@/lib/board/drag-visual";
import { BOARD_COLUMNS } from "@/lib/board/types";
import { acceptsDrop } from "@/lib/board/drag";

describe("dragTransform — the card that follows the cursor", () => {
  it("translates to the pointer offset, which is the whole point of the row", () => {
    // The defect this row exists to fix is a card that does not move at all,
    // so the translation carrying the actual offsets is the assertion that
    // matters most here.
    expect(dragTransform(12, -34, false)).toContain("translate3d(12px, -34px, 0)");
  });

  it("tilts and lifts, so the card reads as picked up rather than slid", () => {
    const transform = dragTransform(0, 0, false);
    expect(transform).toContain(`rotate(${DRAG_TILT_DEG}deg)`);
    expect(transform).toContain(`scale(${DRAG_LIFT_SCALE})`);
  });

  it("drops the tilt and the lift under prefers-reduced-motion", () => {
    const transform = dragTransform(5, 6, true);
    expect(transform).not.toContain("rotate");
    expect(transform).not.toContain("scale");
  });

  it("KEEPS following the cursor under prefers-reduced-motion", () => {
    // The one rule worth stating loudly: reduced motion removes decoration,
    // not information. A drag whose card stopped following the cursor would
    // be the original defect, reintroduced for the people least able to
    // tolerate it.
    expect(dragTransform(7, 8, true)).toBe("translate3d(7px, 8px, 0)");
  });

  it("is a small tilt — a large angle reads as broken rather than lifted", () => {
    expect(DRAG_TILT_DEG).toBeGreaterThan(0);
    expect(DRAG_TILT_DEG).toBeLessThanOrEqual(5);
  });
});

describe("MOTION_MS — the motion budget", () => {
  it("is the budget the row specified", () => {
    expect(MOTION_MS).toEqual({ instant: 75, quick: 150, settle: 250, slow: 400 });
  });

  it("is ordered fastest to slowest, so a name cannot be swapped for another silently", () => {
    expect(MOTION_MS.instant).toBeLessThan(MOTION_MS.quick);
    expect(MOTION_MS.quick).toBeLessThan(MOTION_MS.settle);
    expect(MOTION_MS.settle).toBeLessThan(MOTION_MS.slow);
  });
});

describe("isDropZone — which columns take a pointer drop", () => {
  it("refuses Waiting, whose two states both need fields a drag has not got", () => {
    expect(isDropZone("waiting")).toBe(false);
  });

  it("accepts the three columns a drag can express a move to", () => {
    expect(isDropZone("backlog")).toBe(true);
    expect(isDropZone("in_progress")).toBe(true);
    expect(isDropZone("completed")).toBe(true);
  });

  it("agrees with the native transport's rule for EVERY column, so the two cannot drift", () => {
    // Two transports disagreeing about which columns accept a drop is the
    // failure mode of running both: a column that takes a pointer drop and
    // refuses a keyboard one (or vice versa) is worse than either alone.
    for (const column of BOARD_COLUMNS) {
      expect(isDropZone(column)).toBe(acceptsDrop(column));
    }
  });
});

describe("placeholderColumn — where the card says it will land", () => {
  it("marks the column being hovered while a card is held over it", () => {
    expect(placeholderColumn("item-1", "in_progress", "backlog")).toBe("in_progress");
  });

  it("shows nothing when nothing is being dragged", () => {
    expect(placeholderColumn(null, "in_progress", "backlog")).toBeNull();
  });

  it("shows nothing when the pointer is over no column", () => {
    expect(placeholderColumn("item-1", null, "backlog")).toBeNull();
  });

  it("shows nothing over Waiting, rather than promising a drop that would be refused", () => {
    expect(placeholderColumn("item-1", "waiting", "backlog")).toBeNull();
  });

  it("shows nothing over the card's OWN column, because dropping it back is a no-op", () => {
    // `isMove`'s third condition. A landing site drawn for a move that will
    // not be issued is the same wrong promise as highlighting Waiting.
    expect(placeholderColumn("item-1", "backlog", "backlog")).toBeNull();
  });

  it("still shows when the source column is unknown", () => {
    // A card whose source the caller could not determine is not a reason to
    // withhold the landing site — the drop is still a move.
    expect(placeholderColumn("item-1", "completed", null)).toBe("completed");
  });
});
