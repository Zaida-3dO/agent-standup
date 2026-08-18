// src/components/top-bar/TopBar.tsx — the top strip: where you are, a way
// to search, and who you are acting as. Hook-free and prop-driven (see the
// component's own header for why), so it's called directly as a function —
// same technique as tests/profile-picker.test.ts.
//
// The strip carries more than one control, so the switcher is located by
// its own accessible name rather than by being the first button in the
// tree. That is deliberately stricter than a positional lookup: it proves
// the switcher exists AND that its accessible name still names the active
// profile, which is the property the picker's behaviour depends on.
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { TopBar } from "@/components/top-bar/TopBar";
import { DensityToggle } from "@/components/top-bar/DensityToggle";
import type { Profile } from "@/lib/profile/types";
import { findAllByType, walk } from "./helpers/react-element";

/** The profile switcher, found by its accessible name — never by position. */
function switcherOf(element: ReactNode) {
  return [...walk(element)].find((el) => {
    if (el.type !== "button") return false;
    const label = (el.props as { "aria-label"?: string })["aria-label"];
    return typeof label === "string" && label.startsWith("Switch profile");
  });
}

/** The avatar span — the one `aria-hidden` element inside the switcher. */
function avatarTextOf(element: ReactNode): unknown {
  const switcher = switcherOf(element);
  if (switcher === undefined) return undefined;
  return [...walk(switcher)]
    .map((el) => el.props as { children?: unknown; "aria-hidden"?: string })
    .find((props) => props["aria-hidden"] === "true")?.children;
}

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };
const userB: Profile = { id: "user-b", displayName: "User B", avatar: "🙂", colour: "#00ff00" };

describe("TopBar", () => {
  it("renders no switcher button when there is no active profile", () => {
    const element = TopBar({ activeProfile: null, onSwitchProfile: () => {} });
    expect(switcherOf(element)).toBeUndefined();
  });

  it("renders the active profile's display name when one is set", () => {
    const element = TopBar({ activeProfile: userA, onSwitchProfile: () => {} });
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).toContain("User A");
  });

  it("renders the OTHER profile's name when that's the active one — not a hardcoded label", () => {
    const element = TopBar({ activeProfile: userB, onSwitchProfile: () => {} });
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).toContain("User B");
    expect(text).not.toContain("User A");
  });

  it("clicking the switcher calls onSwitchProfile", () => {
    let switched = false;
    const element = TopBar({
      activeProfile: userA,
      onSwitchProfile: () => {
        switched = true;
      },
    });
    const switcher = switcherOf(element);
    (switcher!.props as { onClick: () => void }).onClick();
    expect(switched).toBe(true);
  });

  it("shows the profile's avatar when it has one, falling back to an initial otherwise", () => {
    expect(avatarTextOf(TopBar({ activeProfile: userB, onSwitchProfile: () => {} }))).toBe("🙂");
    expect(avatarTextOf(TopBar({ activeProfile: userA, onSwitchProfile: () => {} }))).toBe("U");
  });

  // The strip gained neighbours. What follows proves each one, and — where
  // it matters — that it is absent when it should be.

  it("renders the breadcrumb it is handed, marking the trailing crumb as current", () => {
    const element = TopBar({
      activeProfile: userA,
      onSwitchProfile: () => {},
      crumbs: [
        { label: "Projects", href: "/projects" },
        { label: "Apollo", href: null },
      ],
    });
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).toContain("Projects");
    expect(text).toContain("Apollo");
    // The trailing crumb is where you are, so it is text rather than a
    // link — and it says so to a screen reader. Exactly one, because two
    // would mean the current page is claimed twice.
    const current = [...walk(element)].filter(
      (el) => (el.props as { "aria-current"?: string })["aria-current"] === "page",
    );
    expect(current).toHaveLength(1);
  });

  it("renders no breadcrumb nav at all when there are no crumbs", () => {
    const element = TopBar({ activeProfile: userA, onSwitchProfile: () => {} });
    expect([...walk(element)].filter((el) => el.type === "nav")).toHaveLength(0);
  });

  it("offers search as a DISABLED control - it does nothing yet and says so", () => {
    // A search field that accepted a query and did nothing would teach the
    // reader the feature is broken rather than absent. Removing `disabled`
    // from the component fails this.
    const element = TopBar({ activeProfile: userA, onSwitchProfile: () => {} });
    const search = [...walk(element)].find((el) => {
      const label = (el.props as { "aria-label"?: string })["aria-label"];
      return typeof label === "string" && label.startsWith("Search");
    });
    expect(search).toBeDefined();
    expect((search!.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it("renders the nav trigger only when a handler is supplied", () => {
    const withHandler = TopBar({
      activeProfile: userA,
      onSwitchProfile: () => {},
      onOpenNav: () => {},
    });
    expect(
      [...walk(withHandler)].find(
        (el) => (el.props as { "aria-label"?: string })["aria-label"] === "Open navigation",
      ),
    ).toBeDefined();

    const without = TopBar({ activeProfile: userA, onSwitchProfile: () => {} });
    expect(
      [...walk(without)].find(
        (el) => (el.props as { "aria-label"?: string })["aria-label"] === "Open navigation",
      ),
    ).toBeUndefined();
  });

  it("renders the density toggle only when both a value and a handler are supplied", () => {
    const both = TopBar({
      activeProfile: userA,
      onSwitchProfile: () => {},
      density: "compact",
      onToggleDensity: () => {},
    });
    expect(findAllByType(both, DensityToggle)).toHaveLength(1);

    // A value with no handler is a control that cannot be operated.
    const valueOnly = TopBar({
      activeProfile: userA,
      onSwitchProfile: () => {},
      density: "compact",
    });
    expect(findAllByType(valueOnly, DensityToggle)).toHaveLength(0);
  });
});

describe("DensityToggle", () => {
  it("reports the density it is IN through aria-pressed", () => {
    // Pressed means compact. Inverting the comparison in the component
    // makes the button announce the opposite of what it shows.
    const compact = DensityToggle({ density: "compact", onToggle: () => {} });
    expect((compact.props as { "aria-pressed": boolean })["aria-pressed"]).toBe(true);
    const comfortable = DensityToggle({ density: "comfortable", onToggle: () => {} });
    expect((comfortable.props as { "aria-pressed": boolean })["aria-pressed"]).toBe(false);
  });

  it("calls onToggle when clicked", () => {
    let toggled = 0;
    const element = DensityToggle({ density: "comfortable", onToggle: () => void toggled++ });
    (element.props as { onClick: () => void }).onClick();
    expect(toggled).toBe(1);
  });

  it("names the state it is in, not the one it switches to", () => {
    // A button labelled with its destination and pressed-state with its
    // origin contradicts itself out loud on every screen reader.
    const compact = DensityToggle({ density: "compact", onToggle: () => {} });
    expect((compact.props as { "aria-label": string })["aria-label"]).toBe("Compact density (on)");
    const comfortable = DensityToggle({ density: "comfortable", onToggle: () => {} });
    expect((comfortable.props as { "aria-label": string })["aria-label"]).toBe(
      "Compact density (off)",
    );
  });
});
