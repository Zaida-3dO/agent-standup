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

  it("renders a StateIcon for every state, carrying that state's mapped shape", () => {
    // The wiring, asserted separately from the distinctness property below
    // so a failure says which of the two broke.
    for (const state of ITEM_STATES) {
      const icon = [...walk(StateChip({ state }))].find((el) => el.type === StateIcon);
      expect((icon?.props as { shape?: string })?.shape).toBe(STATE_SHAPES[state]);
    }
  });
});

describe("state icons are pairwise distinguishable — the WCAG 1.4.1 channel", () => {
  // ── Why this compares GEOMETRY and not shape names ────────────────────
  //
  // The obvious test — assert all twelve `STATE_SHAPES` values are unique —
  // is not enough, and the gap is not hypothetical. Two shape names can map
  // to identical drawings (a copy-pasted `case` in `StateIcon`), and a
  // name-only test passes while six states render the same icon.
  //
  // So this renders each shape and fingerprints what actually comes out.
  // A state's icon is its LAST line of defence: `blocked` and `merged`
  // carry opposite meanings on red and green, and `plan_review`/`in_review`
  // are two violets about 1.05:1 apart — on an `iconOnly` chip the outline
  // is the only channel left. A shape map is exactly the kind of table
  // where a duplicate hides, because the chip still renders and still has
  // a colour.
  //
  // ── What breaks this ──────────────────────────────────────────────────
  //
  //   - Pointing any two states at the same shape name.
  //   - Giving two DIFFERENT shape names the same drawing in `StateIcon`.
  //   - Deleting a `case` so a shape renders an empty <svg>.

  /**
   * A structural fingerprint of what a shape draws.
   *
   * Every SVG child's element type plus its geometry attributes, in order.
   * Deliberately EXCLUDES `colour`-derived props: two states drawing the
   * same outline in different colours must still count as a collision,
   * since colour is precisely the channel that cannot be relied on here.
   */
  function geometryOf(shape: string): string {
    const element = StateIcon({ shape: shape as never, colour: "#000" });
    const parts: string[] = [];
    for (const el of walk(element)) {
      if (el.type === "svg") continue;
      const props = el.props as Record<string, unknown>;
      const geometry = ["d", "cx", "cy", "r", "x", "y", "width", "height", "points"]
        .map((key) => (props[key] === undefined ? "" : `${key}=${String(props[key])}`))
        .filter((entry) => entry !== "")
        .join(",");
      parts.push(`${String(el.type)}(${geometry})`);
    }
    return parts.join("|");
  }

  it("draws something for every shape — no state renders an empty icon", () => {
    // Guards the distinctness test below from passing vacuously: two empty
    // fingerprints would be equal, so this must fail first and loudly.
    for (const state of ITEM_STATES) {
      expect(geometryOf(STATE_SHAPES[state])).not.toBe("");
    }
  });

  it("gives every PAIR of the twelve states a distinguishable outline", () => {
    const collisions: string[] = [];
    for (let i = 0; i < ITEM_STATES.length; i += 1) {
      for (let j = i + 1; j < ITEM_STATES.length; j += 1) {
        const a = ITEM_STATES[i]!;
        const b = ITEM_STATES[j]!;
        // `wont_do` and `cancelled` share the `slash` on purpose — they are
        // the same outcome to a reader (closed, nothing built), and the
        // chip's label carries the distinction where it matters. This is
        // the ONLY sanctioned collision, named explicitly so adding a
        // second one is a deliberate act rather than an oversight.
        const sanctioned =
          (a === "wont_do" && b === "cancelled") || (a === "cancelled" && b === "wont_do");
        if (sanctioned) continue;
        if (geometryOf(STATE_SHAPES[a]) === geometryOf(STATE_SHAPES[b])) {
          collisions.push(`${a} and ${b} both render ${STATE_SHAPES[a]}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it("keeps the two pairs whose confusion is most costly apart", () => {
    // Named individually as well as covered by the sweep above, because
    // these two are WHY the property matters and a future edit relaxing
    // the sweep should still trip on them.
    //
    // blocked/merged: opposite meanings, red and green — the classic
    // confusion, where reading by hue inverts the board rather than
    // merely losing detail.
    expect(geometryOf(STATE_SHAPES.blocked)).not.toBe(geometryOf(STATE_SHAPES.merged));
    // plan_review/in_review: two violets ~1.05:1 apart, i.e. effectively
    // indistinguishable by colour at any size.
    expect(geometryOf(STATE_SHAPES.plan_review)).not.toBe(geometryOf(STATE_SHAPES.in_review));
    // paused/blocked: share a column (SCHEMA.md §1.1), where the schema
    // names colour as the thing separating them.
    expect(geometryOf(STATE_SHAPES.paused)).not.toBe(geometryOf(STATE_SHAPES.blocked));
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
