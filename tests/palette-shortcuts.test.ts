// The shortcut registry — `@/lib/palette/shortcuts`.
//
// The row's second requirement is that `?` lists every shortcut, on the
// grounds that "an undiscoverable shortcut set is worth very little". The
// registry is a single table so the dispatcher and the help sheet cannot
// disagree; these tests are what makes that a checked property rather than
// an intention stated in a comment.
import { describe, expect, it } from "vitest";
import {
  NAV_PREFIX,
  NAV_SHORTCUT_KEYS,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  navShortcutsFor,
  shortcutsInGroup,
} from "@/lib/palette/shortcuts";
import { NAV_ROUTES } from "@/lib/nav/routes";
import { decideKey } from "@/lib/palette/keys";

describe("the registry's navigation half is derived, not copied", () => {
  it("points every g-sequence at an href that is really in the route map", () => {
    const realHrefs = new Set(NAV_ROUTES.map((route) => route.href));
    const navShortcuts = SHORTCUTS.filter((shortcut) => shortcut.intent.kind === "navigate");
    // Five letters are mapped; if this ever silently became zero the loop
    // below would vacuously pass, so the count is asserted first.
    expect(navShortcuts).toHaveLength(Object.keys(NAV_SHORTCUT_KEYS).length);
    for (const shortcut of navShortcuts) {
      if (shortcut.intent.kind !== "navigate") throw new Error("filtered above");
      expect(realHrefs).toContain(shortcut.intent.href);
    }
  });

  it("takes its label from the route, so a renamed destination renames its shortcut", () => {
    // Fed a route map with a renamed destination. A registry that held its
    // own hand-written label would still say "Go to Board" here.
    const renamed = navShortcutsFor([{ id: "board", label: "Kanban", href: "/kanban" }]);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.label).toBe("Go to Kanban");
    expect(renamed[0]?.intent).toEqual({ kind: "navigate", href: "/kanban" });
  });

  it("emits nothing for a destination the route map does not have", () => {
    // A shortcut pointing at a removed page would navigate to a 404 while
    // still looking correct in the help sheet.
    expect(navShortcutsFor([])).toHaveLength(0);
  });
});

describe("every registered shortcut is both dispatchable and listed", () => {
  // The property the whole table exists for. A shortcut the dispatcher
  // honours but the sheet omits is undiscoverable; one the sheet lists but
  // the dispatcher ignores is a lie printed on screen.
  it("dispatches every single-key entry to the intent the registry declares", () => {
    const singles = SHORTCUTS.filter(
      (shortcut) => shortcut.press === "sequence" && shortcut.keys.length === 1,
    );
    expect(singles.length).toBeGreaterThan(0);
    for (const shortcut of singles) {
      const decision = decideKey({ key: shortcut.keys[0]! }, null, {
        typing: false,
        overlayOpen: false,
      });
      expect(decision.intent).toEqual(shortcut.intent);
    }
  });

  it("dispatches every two-key entry through its prefix", () => {
    const pairs = SHORTCUTS.filter(
      (shortcut) => shortcut.press === "sequence" && shortcut.keys.length === 2,
    );
    expect(pairs.length).toBeGreaterThan(0);
    for (const shortcut of pairs) {
      expect(shortcut.keys[0]).toBe(NAV_PREFIX);
      const decision = decideKey({ key: shortcut.keys[1]! }, NAV_PREFIX, {
        typing: false,
        overlayOpen: false,
      });
      expect(decision.intent).toEqual(shortcut.intent);
    }
  });

  it("places every shortcut in a group the help sheet renders", () => {
    // The sheet iterates `SHORTCUT_GROUPS`. An entry in a group not on that
    // list would work and never appear — exactly the undiscoverable case.
    for (const shortcut of SHORTCUTS) {
      expect(SHORTCUT_GROUPS).toContain(shortcut.group);
    }
  });

  it("accounts for every shortcut across the groups, with none listed twice", () => {
    const grouped = SHORTCUT_GROUPS.flatMap((group) => shortcutsInGroup(group));
    expect(grouped).toHaveLength(SHORTCUTS.length);
    expect(new Set(grouped.map((shortcut) => shortcut.id)).size).toBe(SHORTCUTS.length);
  });

  it("gives every entry a distinct id", () => {
    expect(new Set(SHORTCUTS.map((shortcut) => shortcut.id)).size).toBe(SHORTCUTS.length);
  });
});

describe("shortcutsInGroup", () => {
  it("returns only the named group, in registry order", () => {
    const navigate = shortcutsInGroup("Navigate");
    expect(navigate.length).toBeGreaterThan(0);
    expect(navigate.every((shortcut) => shortcut.group === "Navigate")).toBe(true);
    // Order is the registry's, so the sheet's reading order is stable.
    const ids = navigate.map((shortcut) => shortcut.id);
    const registryOrder = SHORTCUTS.filter((s) => s.group === "Navigate").map((s) => s.id);
    expect(ids).toEqual(registryOrder);
  });
});

describe("a chord is not a sequence", () => {
  it("marks the palette chord as a chord, not as a g-style pair", () => {
    // Both entries carry two keys. Inferring the kind from `keys.length`
    // made the palette reachable as `g` then `K`, which is what this field
    // exists to prevent.
    const palette = SHORTCUTS.find((shortcut) => shortcut.id === "palette");
    expect(palette?.keys).toHaveLength(2);
    expect(palette?.press).toBe("chord");
  });

  it("does not complete the g prefix with the chord's second key", () => {
    const decision = decideKey({ key: "K" }, NAV_PREFIX, { typing: false, overlayOpen: false });
    expect(decision.intent).toBeNull();
  });

  it("marks every navigation pair as a sequence", () => {
    for (const shortcut of SHORTCUTS.filter((s) => s.group === "Navigate")) {
      expect(shortcut.press).toBe("sequence");
      expect(shortcut.keys[0]).toBe(NAV_PREFIX);
    }
  });
});
