// The saved-view highlight is actually SUPPLIED — the gap `currentHrefFrom`'s
// own tests could not see.
//
// ── Why this file exists ──────────────────────────────────────────────
//
// `currentHrefFrom` was correct, exported, and covered by three assertions
// in `tests/board-saved-views.test.ts` — and **no production code called
// it**. `SavedViewLinks` compared a `currentHref` prop that was threaded
// through `AppShellView` and `SidebarView` and never given a value, so the
// highlight was dead in the shipped app while its unit tests stayed green.
//
// A test that proves a function computes the right string cannot notice
// that nobody asks it. So these assert the WIRING rather than the
// computation: that the sidebar reaches for the address on its own, and
// that the value it obtains arrives at the element that renders
// `aria-current`.
//
// **What each test would catch.** Deleting the `CurrentHrefProbe` branch in
// `SidebarView`, so it only ever passes `currentHref` straight through,
// fails "reaches for the address itself". Dropping the `currentHref={href}`
// prop inside the probe's render callback fails "hands the probed address
// to the links". Flipping `SavedViewLinks`' comparison to `!==`, or emitting
// `undefined` where it should emit `"page"`, fails the marking tests below.
import { describe, expect, it } from "vitest";
import { SidebarView } from "@/components/sidebar/SidebarView";
import { CurrentHrefProbe } from "@/components/sidebar/CurrentHrefProbe";
import { SavedViewLinks } from "@/components/sidebar/SavedViewLinks";
import { emptyCounts } from "@/lib/nav/counts";
import { findAllByType, findOneByType, walk } from "./helpers/react-element";

const views = [
  { name: "My P0s", href: "/board?priority=P0" },
  { name: "Everything", href: "/board" },
];

function sidebar(overrides: Partial<Parameters<typeof SidebarView>[0]> = {}) {
  return SidebarView({
    pathname: "/board",
    counts: emptyCounts(),
    sheetOpen: false,
    onCloseSheet: () => {},
    savedViews: views,
    ...overrides,
  });
}

/** The `aria-current` on each rendered saved-view link, in order. */
function currentFlags(element: unknown): unknown[] {
  return [...walk(element as never)]
    .filter((el) => typeof el.type !== "string" || el.type === "a")
    .flatMap((el) => {
      const props = el.props as { "aria-current"?: unknown; href?: unknown };
      return props.href === undefined ? [] : [props["aria-current"]];
    });
}

describe("the sidebar obtains the current address rather than waiting to be told", () => {
  it("reaches for the address itself when the shell does not supply one", () => {
    // The shell must NOT be the one reading search params — doing that in
    // `AppShell` opts every page out of static rendering. So with no
    // `currentHref` prop, the sidebar is expected to render the probe.
    const element = sidebar();
    expect(findAllByType(element, CurrentHrefProbe).length).toBeGreaterThan(0);
  });

  it("hands the probed address to the links, rather than dropping it", () => {
    // Calls the probe's own render callback with a known address and
    // checks the value lands on `SavedViewLinks`. This is the assertion
    // that fails if the render callback stops forwarding `href` — the
    // precise shape of the original bug, one level down.
    const probe = findAllByType(sidebar(), CurrentHrefProbe)[0]!;
    const render = (probe.props as { children: (href: string | null) => unknown }).children;
    const links = findOneByType(render("/board?priority=P0") as never, SavedViewLinks);
    expect((links.props as { currentHref?: unknown }).currentHref).toBe("/board?priority=P0");
  });

  it("an explicitly supplied address still wins, so a test can drive it", () => {
    const element = sidebar({ currentHref: "/board" });
    expect(findAllByType(element, CurrentHrefProbe)).toHaveLength(0);
    const links = findAllByType(element, SavedViewLinks);
    expect((links[0]!.props as { currentHref?: unknown }).currentHref).toBe("/board");
  });
});

describe("which pinned view marks itself current", () => {
  it("marks exactly the view whose href matches the address", () => {
    const element = SavedViewLinks({ views, currentHref: "/board?priority=P0" });
    // First view matches, second does not — so this fails both if nothing
    // is marked and if everything is.
    expect(currentFlags(element)).toEqual(["page", undefined]);
  });

  it("marks the unfiltered view on a bare /board, where the query is empty", () => {
    const element = SavedViewLinks({ views, currentHref: "/board" });
    expect(currentFlags(element)).toEqual([undefined, "page"]);
  });

  it("marks nothing when the board matches none of the saved views", () => {
    const element = SavedViewLinks({ views, currentHref: "/board?area=web" });
    expect(currentFlags(element)).toEqual([undefined, undefined]);
  });

  it("marks nothing when the address is unknown — never a default first view", () => {
    // `usePathname` returns null before the router resolves; that must not
    // become "the first view is current".
    const element = SavedViewLinks({ views, currentHref: null });
    expect(currentFlags(element)).toEqual([undefined, undefined]);
  });
});
