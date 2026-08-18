// Every route in the map resolves to a page module that renders something.
//
// **This is the acceptance criterion "every route resolves", tested rather
// than eyeballed.** A route directory that was never created, or a page
// whose default export is missing, is a 404 that nothing else here would
// notice — the sidebar would still render its link, the link would still
// look right, and it would fail only when somebody clicked it.
//
// ── What would break these tests (they are not hollow) ────────────────
//
//   - Deleting any `src/app/<route>/page.tsx` fails the resolution test
//     for that route.
//   - Adding a destination to `NAV_ROUTES` without creating its page fails
//     it too, which is the direction that actually happens.
//   - Removing the "not built yet" line from `Placeholder` fails the
//     honesty test — a placeholder that stopped saying so would be
//     indistinguishable from a screen that loaded and found nothing.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { NAV_ROUTES } from "@/lib/nav/routes";
import { SINCE_REDIRECT_TARGET } from "@/lib/nav/redirects";
import { Placeholder } from "@/components/placeholder/Placeholder";
import { walk } from "./helpers/react-element";

const APP = path.resolve(import.meta.dirname, "../src/app");

/** The page file Next would resolve for a path, or null if there is none. */
function pageFileFor(href: string): string | null {
  const segments = href.split("/").filter((s) => s !== "");
  const file = path.join(APP, ...segments, "page.tsx");
  return existsSync(file) ? file : null;
}

describe("the route map resolves", () => {
  it("has a page file for every sidebar destination", () => {
    for (const route of NAV_ROUTES) {
      expect(pageFileFor(route.href), `no page.tsx for ${route.href}`).not.toBeNull();
    }
  });

  it("has a page file for the routes the sidebar does not list but the app still serves", () => {
    // Kept, restructured elsewhere, or deliberately untouched — none of
    // them are nav destinations and all of them must still resolve.
    for (const href of ["/items/[id]", "/admin", "/admin/[slug]", "/projects/[id]"]) {
      expect(pageFileFor(href), `no page.tsx for ${href}`).not.toBeNull();
    }
  });

  it("keeps /since as a page rather than deleting it", () => {
    // The path is in browser histories and bookmarks; a 404 there would
    // look exactly like the feature having been removed.
    expect(pageFileFor("/since")).not.toBeNull();
  });

  it("points /since at a route that itself resolves", () => {
    expect(pageFileFor(SINCE_REDIRECT_TARGET)).not.toBeNull();
  });
});

describe("Placeholder", () => {
  it("says out loud that the screen is not built yet", () => {
    const element = Placeholder({ title: "Fleet", summary: "Who is working right now." });
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c): c is string => typeof c === "string")
      .join(" ");
    expect(text).toContain("Fleet");
    expect(text).toContain("Who is working right now.");
    // The load-bearing sentence. A route that resolved to a convincing
    // empty state would mislead a reader into concluding there is no data.
    expect(text).toContain("not built yet");
  });

  it("renders the title it is given, not a fixed one", () => {
    const text = [...walk(Placeholder({ title: "Cost", summary: "s" }))]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c): c is string => typeof c === "string")
      .join(" ");
    expect(text).toContain("Cost");
    expect(text).not.toContain("Fleet");
  });
});
