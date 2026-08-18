// `src/components/sidebar/` — the nav list and the rail/sheet placement.
//
// Hook-free and prop-driven (see `TopBar.tsx`'s header), so these are
// called directly as functions and their element trees inspected — the
// technique `tests/helpers/react-element.ts` documents.
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import Link from "next/link";
import { SidebarNav } from "@/components/sidebar/SidebarNav";
import { SidebarView } from "@/components/sidebar/SidebarView";
import { hasIcon, NavIcon } from "@/components/sidebar/NavIcon";
import { NAV_ROUTES } from "@/lib/nav/routes";
import { emptyCounts } from "@/lib/nav/counts";
import { findAllByType, walk } from "./helpers/react-element";

/** Every `next/link` in the tree, with its href and its `aria-current`. */
function links(element: ReactNode) {
  return findAllByType(element, Link).map((el) => {
    const props = el.props as { href: string; "aria-current"?: string };
    return { href: props.href, current: props["aria-current"] };
  });
}

/**
 * Every leaf value rendered anywhere in the tree, as strings.
 *
 * Numbers are stringified rather than filtered out: a badge count reaches
 * the tree as a `number` child, and a helper that only collected strings
 * would silently find no badges at all and make the badge assertions pass
 * for the wrong reason.
 */
function texts(element: ReactNode): string[] {
  return [...walk(element)]
    .flatMap((el) => {
      const children = (el.props as { children?: unknown }).children;
      return Array.isArray(children) ? children : [children];
    })
    .filter((c): c is string | number => typeof c === "string" || typeof c === "number")
    .map(String);
}

describe("SidebarNav", () => {
  it("renders one link per declared destination, in the route map's order", () => {
    const element = SidebarNav({ pathname: "/board", counts: emptyCounts() });
    expect(links(element).map((l) => l.href)).toEqual(NAV_ROUTES.map((r) => r.href));
  });

  it("marks exactly the current destination with aria-current, and nothing else", () => {
    const element = SidebarNav({ pathname: "/board", counts: emptyCounts() });
    const current = links(element).filter((l) => l.current === "page");
    expect(current).toEqual([{ href: "/board", current: "page" }]);
  });

  it("marks the owning destination on a nested path", () => {
    const element = SidebarNav({ pathname: "/projects/abc", counts: emptyCounts() });
    expect(
      links(element)
        .filter((l) => l.current === "page")
        .map((l) => l.href),
    ).toEqual(["/projects"]);
  });

  it("does NOT keep Standup lit on every screen", () => {
    // `/` is a prefix of every path. Prefix-matching it would highlight
    // Standup everywhere and the highlight would say nothing.
    const element = SidebarNav({ pathname: "/fleet", counts: emptyCounts() });
    expect(links(element).find((l) => l.href === "/")?.current).toBeUndefined();
  });

  it("highlights nothing before the router has resolved a path", () => {
    const element = SidebarNav({ pathname: null, counts: emptyCounts() });
    expect(links(element).filter((l) => l.current === "page")).toEqual([]);
  });

  it("renders the live badge numbers it is handed", () => {
    const element = SidebarNav({ pathname: "/", counts: { unseen: 4, needsYou: 9 } });
    const rendered = texts(element);
    // Both numbers reach the DOM. Hardcoding either in the component would
    // survive this only if the hardcoded value happened to be 4 or 9.
    expect(rendered).toContain("4");
    expect(rendered).toContain("9");
  });

  it("renders NO badge at zero", () => {
    // A badge reading "0" occupies the spot the eye checks for a number
    // and answers a question nobody asked. Changing `count > 0` to
    // `count >= 0` fails this.
    const element = SidebarNav({ pathname: "/", counts: emptyCounts() });
    expect(texts(element)).not.toContain("0");
  });

  it("puts each badge on its own destination, not on both", () => {
    const element = SidebarNav({ pathname: "/", counts: { unseen: 4, needsYou: 9 } });
    const withBadges = findAllByType(element, Link).filter((el) =>
      [...walk(el)].some((child) => {
        const props = child.props as { "aria-label"?: string };
        return typeof props["aria-label"] === "string" && /^\d+ /.test(props["aria-label"]);
      }),
    );
    // Swapping the two branches of `countForBadge` would still give two
    // badged links, so this asserts WHICH number landed on which link.
    const labelled = withBadges.map((el) => {
      const href = (el.props as { href: string }).href;
      const badge = [...walk(el)]
        .map((child) => (child.props as { "aria-label"?: string })["aria-label"])
        .find((label) => typeof label === "string" && /^\d+ /.test(label));
      return { href, badge };
    });
    expect(labelled).toEqual([
      { href: "/", badge: "4 standup" },
      { href: "/needs-you", badge: "9 needs you" },
    ]);
  });

  it("calls onNavigate when a destination is chosen, so the sheet can close itself", () => {
    let called = 0;
    const element = SidebarNav({
      pathname: "/",
      counts: emptyCounts(),
      onNavigate: () => void called++,
    });
    const first = findAllByType(element, Link)[0]!;
    (first.props as { onClick: () => void }).onClick();
    expect(called).toBe(1);
  });
});

describe("NavIcon", () => {
  it("has a mapping for every icon the route map names", () => {
    // A route added with an unmapped icon name renders no icon at all, and
    // nothing else would notice. This is the thing that notices.
    for (const route of NAV_ROUTES) {
      expect(hasIcon(route.icon), `no icon mapped for "${route.icon}"`).toBe(true);
    }
  });

  it("renders nothing for a name with no mapping", () => {
    expect(NavIcon({ name: "not-an-icon" })).toBeNull();
  });
});

describe("SidebarView", () => {
  it("renders the rail with the nav in it, and no sheet, when the sheet is closed", () => {
    const element = SidebarView({
      pathname: "/board",
      counts: emptyCounts(),
      sheetOpen: false,
      onCloseSheet: () => {},
    });
    expect(findAllByType(element, SidebarNav)).toHaveLength(1);
    // No dialog while the sheet is closed.
    const dialogs = [...walk(element)].filter(
      (el) => (el.props as { role?: string }).role === "dialog",
    );
    expect(dialogs).toHaveLength(0);
  });

  it("renders a second copy of the nav inside a modal sheet when open", () => {
    const element = SidebarView({
      pathname: "/board",
      counts: emptyCounts(),
      sheetOpen: true,
      onCloseSheet: () => {},
    });
    // The rail's copy plus the sheet's copy — the LIST is shared, which is
    // what stops a route existing in one and not the other.
    expect(findAllByType(element, SidebarNav)).toHaveLength(2);
    const dialog = [...walk(element)].find(
      (el) => (el.props as { role?: string }).role === "dialog",
    );
    expect(dialog).toBeDefined();
    // JSX serialises this attribute as a string, which is what React
    // renders into the DOM.
    expect((dialog!.props as { "aria-modal"?: string | boolean })["aria-modal"]).toBe("true");
  });

  it("closes the sheet from the scrim, the close button, and choosing a destination", () => {
    let closed = 0;
    const element = SidebarView({
      pathname: "/board",
      counts: emptyCounts(),
      sheetOpen: true,
      onCloseSheet: () => void closed++,
    });
    const buttons = [...walk(element)].filter((el) => el.type === "button");
    for (const button of buttons) (button.props as { onClick: () => void }).onClick();
    // Scrim and close button.
    expect(closed).toBe(2);
    // …and the nav inside the sheet closes it on navigate. The rail's copy
    // must NOT — it is not covering anything.
    const navs = findAllByType(element, SidebarNav);
    expect((navs[0]!.props as { onNavigate?: () => void }).onNavigate).toBeUndefined();
    (navs[1]!.props as { onNavigate: () => void }).onNavigate();
    expect(closed).toBe(3);
  });
});
