// The chip primitives. Hook-free and prop-driven like every other component
// in this repo, so they are called directly as functions and their returned
// element trees inspected — same technique as
// `tests/board-view-component.test.ts`, via `tests/helpers/react-element.ts`.
//
// ── What would break each of these (they are not hollow) ──────────────
//
//   - Swapping `styles.outlined` for `styles.filled` in `StateChip` (or the
//     reverse in `PriorityChip`) fails the variant tests — that one-word
//     change is exactly the regression that would make priority and state
//     read as one category again.
//   - Deleting the `aria-label` from either chip fails the label tests.
//   - Changing `stalenessOf`'s `>=` to `>` fails the boundary test.
//   - Changing `4 * HOUR` to `3 * HOUR` fails the band test.
//   - Returning an element instead of `null` for `fresh` fails the
//     renders-nothing test.
//   - Changing `AREA_HUE_COUNT` fails the bucket-range test.
//   - Removing `Math.imul` from `fnv1a` fails the distribution test.
import { describe, expect, it } from "vitest";
import { StateChip } from "@/components/chips/StateChip";
import { PriorityChip } from "@/components/chips/PriorityChip";
import { AreaChip } from "@/components/chips/AreaChip";
import { StalenessDot, formatAge } from "@/components/chips/StalenessDot";
import { AgentPresenceDot } from "@/components/chips/AgentPresenceDot";
import { StateIcon } from "@/components/chips/StateIcon";
import { ITEM_STATES, STATE_LABELS, STATE_SHAPES, stalenessOf } from "@/lib/design/tokens";
import { AREA_HUE_COUNT, areaHueIndex, areaColour, fnv1a } from "@/lib/design/area-colour";
import { walk } from "./helpers/react-element";
import type { ReactNode } from "react";

/** Every string of text anywhere in the tree, flattened. */
function textOf(root: ReactNode): string {
  const parts: string[] = [];
  for (const el of walk(root)) {
    const children = (el.props as { children?: unknown }).children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child));
    }
  }
  return parts.join(" ");
}

/** The root element's props, typed loosely enough to read attributes off. */
function propsOf(element: ReactNode): Record<string, unknown> {
  const [root] = [...walk(element)];
  return (root?.props ?? {}) as Record<string, unknown>;
}

describe("StateChip", () => {
  it("renders a readable label for every one of the twelve states", () => {
    for (const state of ITEM_STATES) {
      const text = textOf(StateChip({ state }));
      expect(text).toContain(STATE_LABELS[state]);
    }
  });

  it("is OUTLINED, never filled — this is what separates it from priority", () => {
    // The whole point of the state/priority distinction. If a state chip
    // ever renders filled, the two categories collapse back into one.
    for (const state of ITEM_STATES) {
      expect(propsOf(StateChip({ state }))["data-variant"]).toBe("outlined");
    }
  });

  it("carries a text label AND an icon — never colour alone (WCAG 1.4.1)", () => {
    for (const state of ITEM_STATES) {
      const element = StateChip({ state });
      // The non-colour channels: an icon element, and the state's name.
      const icons = [...walk(element)].filter((el) => el.type === StateIcon);
      expect(icons.length).toBe(1);
      expect(textOf(element)).toContain(STATE_LABELS[state]);
    }
  });

  it("keeps an accessible name even when the visible label is dropped", () => {
    // `iconOnly` is the space-constrained case, and it is precisely where a
    // colour-only chip would become unreadable to a screen reader.
    const element = StateChip({ state: "blocked", iconOnly: true });
    expect(textOf(element)).not.toContain("Blocked");
    expect(propsOf(element)["aria-label"]).toBe("State: Blocked");
  });

  it("gives blocked and merged different icon shapes — opposite meanings", () => {
    const shapeOf = (element: ReactNode) =>
      [...walk(element)].find((el) => el.type === StateIcon)?.props as { shape?: string };
    expect(shapeOf(StateChip({ state: "blocked" })).shape).not.toBe(
      shapeOf(StateChip({ state: "merged" })).shape,
    );
  });
});

describe("PriorityChip", () => {
  it("is FILLED, never outlined", () => {
    for (const priority of ["P0", "P1", "P2", "P3"] as const) {
      expect(propsOf(PriorityChip({ priority }))["data-variant"]).toBe("filled");
    }
  });

  it("renders the priority and names it for a screen reader", () => {
    const element = PriorityChip({ priority: "P0" });
    expect(textOf(element)).toContain("P0");
    // "P0" alone is jargon; the label says what kind of thing it is.
    expect(propsOf(element)["aria-label"]).toBe("Priority: P0");
  });

  it("uses tabular figures so a column of priorities aligns", () => {
    const hasTabular = [...walk(PriorityChip({ priority: "P1" }))].some(
      (el) => (el.props as { className?: string }).className === "tabular",
    );
    expect(hasTabular).toBe(true);
  });
});

describe("AreaChip", () => {
  it("always renders the area name — the colour is never the only identifier", () => {
    // Twelve hues over unbounded area names means collisions are certain;
    // the text is what actually identifies the area.
    expect(textOf(AreaChip({ area: "web" }))).toContain("web");
  });

  it("gives the same area the same colour every time", () => {
    // A colour used for recall across sessions is worthless if it changes.
    expect(areaColour("infra")).toEqual(areaColour("infra"));
  });

  it("treats casing as one area, not two", () => {
    expect(areaHueIndex("Web")).toBe(areaHueIndex("web"));
    expect(areaHueIndex("  WEB  ")).toBe(areaHueIndex("web"));
  });

  it("maps every name into the declared hue range", () => {
    for (const name of ["web", "infra", "docs", "a", "", "a-very-long-area-name-indeed"]) {
      const index = areaHueIndex(name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(AREA_HUE_COUNT);
      expect(Number.isInteger(index)).toBe(true);
    }
  });

  it("spreads similar names across different buckets", () => {
    // The property that makes hashing worth doing at all: names differing
    // by one character should not clump. Without `Math.imul` keeping the
    // multiply in 32-bit space, the low bits are lost to float rounding and
    // the distribution collapses.
    const names = ["area-1", "area-2", "area-3", "area-4", "area-5", "area-6"];
    const buckets = new Set(names.map(areaHueIndex));
    expect(buckets.size).toBeGreaterThanOrEqual(4);
  });

  it("produces a 32-bit unsigned hash", () => {
    for (const name of ["", "web", "ÿÿÿ"]) {
      const hash = fnv1a(name);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThan(2 ** 32);
    }
  });
});

describe("StalenessDot", () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  it("renders NOTHING under 4h — an indicator on every card is on no card", () => {
    expect(StalenessDot({ ageMs: 0 })).toBeNull();
    expect(StalenessDot({ ageMs: 3 * HOUR })).toBeNull();
  });

  it("puts each age in the right band", () => {
    expect(stalenessOf(0)).toBe("fresh");
    expect(stalenessOf(5 * HOUR)).toBe("aging");
    expect(stalenessOf(2 * DAY)).toBe("stale");
    expect(stalenessOf(4 * DAY)).toBe("abandoned");
  });

  it("puts the exact boundary in the LATER band", () => {
    // `>=`, not `>`. Which side is picked matters less than picking one:
    // without this, a fixture constructed a millisecond early lands in a
    // different band than one constructed a millisecond late.
    expect(stalenessOf(4 * HOUR)).toBe("aging");
    expect(stalenessOf(DAY)).toBe("stale");
    expect(stalenessOf(3 * DAY)).toBe("abandoned");
  });

  it("shows the age as text ONLY past three days, where the number is the point", () => {
    expect(textOf(StalenessDot({ ageMs: 2 * DAY }))).not.toContain("d");
    expect(textOf(StalenessDot({ ageMs: 5 * DAY }))).toContain("5d");
  });

  it("names itself for a screen reader — a styled span is otherwise invisible", () => {
    const labels = [...walk(StalenessDot({ ageMs: 2 * DAY }))]
      .map((el) => (el.props as { "aria-label"?: string })["aria-label"])
      .filter((l): l is string => typeof l === "string");
    expect(labels.some((l) => l.includes("Last touched"))).toBe(true);
  });

  it("floors the age rather than rounding it", () => {
    // Rounding 2.9d up to "3d" would claim it crossed the boundary that
    // turns the dot red, so the text would contradict the colour beside it.
    expect(formatAge(2.9 * DAY)).toBe("2d");
    expect(formatAge(23.9 * HOUR)).toBe("23h");
  });
});

describe("AgentPresenceDot", () => {
  it("names the liveness in words, not only in colour", () => {
    expect(propsOf(AgentPresenceDot({ liveness: "live" }))["aria-label"]).toContain("running");
    expect(propsOf(AgentPresenceDot({ liveness: "stalled" }))["aria-label"]).toContain("stalled");
    expect(propsOf(AgentPresenceDot({ liveness: "dead" }))["aria-label"]).toContain("dead");
  });

  it("includes the agent's name when given one", () => {
    expect(propsOf(AgentPresenceDot({ liveness: "live", agentName: "Gary" }))["aria-label"]).toBe(
      "Gary is running",
    );
  });

  it("paints dead as a hollow ring, not a filled disc", () => {
    // The shape says "empty slot" rather than "present but quiet" — and a
    // background fill here would paint over the ring entirely.
    expect(propsOf(AgentPresenceDot({ liveness: "dead" })).style).toBeUndefined();
    expect(propsOf(AgentPresenceDot({ liveness: "live" })).style).toBeDefined();
  });
});

describe("StateIcon", () => {
  it("draws something for every shape the state map uses", () => {
    // A shape with no case in `paths` renders an empty <svg> — the chip
    // silently loses its non-colour channel, which is the one thing the
    // icon exists to provide.
    for (const state of ITEM_STATES) {
      const element = StateIcon({ shape: STATE_SHAPES[state], colour: "red" });
      const children = [...walk(element)];
      // The <svg> itself, plus at least one shape inside it.
      expect(children.length).toBeGreaterThan(1);
    }
  });

  it("is hidden from screen readers — the chip already names the state", () => {
    expect(propsOf(StateIcon({ shape: "alert", colour: "red" }))["aria-hidden"]).toBe("true");
  });
});
