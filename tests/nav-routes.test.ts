// `src/lib/nav/routes.ts` — the route map and the active-item rule.
//
// Plain data and pure functions, so these are called directly rather than
// through a render (`tests/helpers/react-element.ts` explains the
// approach this repo uses for the component half).
import { describe, expect, it } from "vitest";
import { NAV_ROUTES, activeRoute, isActiveRoute, type NavId } from "@/lib/nav/routes";

describe("NAV_ROUTES", () => {
  it("declares every destination the app shell navigates to, in triage-first order", () => {
    // The ORDER is the assertion, not just the membership: it is a claim
    // about which screen the eye reaches first, and re-sorting the list
    // (alphabetically, say) would break this.
    expect(NAV_ROUTES.map((route) => route.id)).toEqual([
      "standup",
      "projects",
      "board",
      "needs-you",
      "fleet",
      "activity",
      "cost",
      "budget",
      "settings",
    ]);
  });

  it("points every destination at a distinct absolute path", () => {
    const paths = NAV_ROUTES.map((route) => route.href);
    expect(paths.every((path) => path.startsWith("/"))).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("puts the kanban at /board, not at the root — the root is the landing choice", () => {
    expect(NAV_ROUTES.find((route) => route.id === "board")?.href).toBe("/board");
    expect(NAV_ROUTES.find((route) => route.id === "standup")?.href).toBe("/");
  });

  it("badges exactly the two destinations that carry a live count, and no others", () => {
    // A badge is a claim that something is waiting for you. Adding one to a
    // third destination — or dropping one of these two — changes what the
    // sidebar promises, so it is asserted as an exact set.
    const badged = NAV_ROUTES.filter((route) => route.badge !== undefined).map((route) => [
      route.id,
      route.badge,
    ]);
    expect(badged).toEqual([
      ["standup", "unseen"],
      ["needs-you", "needsYou"],
    ]);
  });

  it("gives every destination a non-empty label and icon name", () => {
    for (const route of NAV_ROUTES) {
      expect(route.label.length).toBeGreaterThan(0);
      expect(route.icon.length).toBeGreaterThan(0);
    }
  });
});

describe("isActiveRoute", () => {
  it("matches a path nested under the destination", () => {
    expect(isActiveRoute("/projects", "/projects/abc")).toBe(true);
  });

  it("matches the destination itself", () => {
    expect(isActiveRoute("/projects", "/projects")).toBe(true);
  });

  it("does NOT match a different route that merely starts with the same characters", () => {
    // The trap a bare `startsWith` falls into: `/projects-archive` would
    // light up Projects. Deleting the `/` from the template literal in
    // `isActiveRoute` makes this pass wrongly.
    expect(isActiveRoute("/projects", "/projects-archive")).toBe(false);
  });

  it("matches the root ONLY exactly — it is a prefix of every path", () => {
    expect(isActiveRoute("/", "/")).toBe(true);
    // Without the root's special case, Standup would be highlighted on
    // every screen in the app and the highlight would carry no information.
    expect(isActiveRoute("/", "/board")).toBe(false);
    expect(isActiveRoute("/", "/items/abc")).toBe(false);
  });
});

describe("activeRoute", () => {
  it("resolves a nested path to the destination that owns it", () => {
    expect(activeRoute("/projects/abc")?.id).toBe<NavId>("projects");
  });

  it("resolves the root to Standup", () => {
    expect(activeRoute("/")?.id).toBe<NavId>("standup");
  });

  it("returns null for a path outside the map", () => {
    // Both are real, reachable routes that the sidebar deliberately does
    // not list — a breadcrumb has to cope with them.
    expect(activeRoute("/items/abc")).toBeNull();
    expect(activeRoute("/admin/repos")).toBeNull();
  });

  it("prefers the longest matching destination, not the first declared", () => {
    // The map declares no overlapping pair, so this proves the RULE rather
    // than a case: `/settings` and `/` both match `/settings`, and the
    // longer one must win. Swapping `>` for `<` in `activeRoute` fails it.
    expect(activeRoute("/settings")?.id).toBe<NavId>("settings");
  });
});
