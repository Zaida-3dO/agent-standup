// src/components/app-shell/AppShellView.tsx — the first-run entry
// MILESTONES.md #86 adds to row #35's profile gate.
//
// Kept separate from `tests/app-shell-view.test.ts` so that file stays the
// record of #35's own branches; this one covers only the escape and, just as
// importantly, that it does not widen the gate anywhere else.
import { describe, expect, it } from "vitest";
import { AppShellView, type AppShellViewProps } from "@/components/app-shell/AppShellView";
import { ProfilePicker } from "@/components/profile-picker/ProfilePicker";
import { TopBar } from "@/components/top-bar/TopBar";
import type { Profile } from "@/lib/profile/types";
import { findAllByType, walk } from "./helpers/react-element";

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };

function baseProps(overrides: Partial<AppShellViewProps> = {}): AppShellViewProps {
  return {
    people: null,
    activeProfile: null,
    error: null,
    pickerOpen: false,
    choose: () => {},
    closePicker: () => {},
    openPicker: () => {},
    children: "page content",
    ...overrides,
  };
}

function showsChildren(element: unknown): boolean {
  for (const node of walk(element as never)) {
    const children = (node.props as { children?: unknown }).children;
    if (children === "page content") return true;
  }
  return false;
}

describe("first-run entry to the configuration surfaces", () => {
  it("shows the settings page rather than the dead-end picker when no profiles exist", () => {
    // With zero profiles the picker has nothing to choose and no way past
    // it, so the surface that could fix that must be reachable.
    const element = AppShellView(baseProps({ people: [], pathname: "/settings" }));
    expect(showsChildren(element)).toBe(true);
    expect(findAllByType(element, ProfilePicker).length).toBe(0);
  });

  it("shows an administration page on a first run too", () => {
    const element = AppShellView(baseProps({ people: [], pathname: "/admin/repos" }));
    expect(showsChildren(element)).toBe(true);
  });

  it("still shows the picker for the board on a first run", () => {
    const element = AppShellView(baseProps({ people: [], pathname: "/" }));
    expect(findAllByType(element, ProfilePicker).length).toBe(1);
    expect(showsChildren(element)).toBe(false);
  });

  it("still shows the picker for the settings page when profiles do exist", () => {
    // The escape must not become a general way to skip attribution.
    const element = AppShellView(baseProps({ people: [userA], pathname: "/settings" }));
    expect(findAllByType(element, ProfilePicker).length).toBe(1);
    expect(showsChildren(element)).toBe(false);
  });

  it("gates everything when the caller does not supply a path", () => {
    // A caller that does not know the path gets the pre-existing behaviour,
    // never an accidental escape.
    const element = AppShellView(baseProps({ people: [] }));
    expect(findAllByType(element, ProfilePicker).length).toBe(1);
  });

  it("shows no top bar on the first-run page — there is no profile to name in it", () => {
    const element = AppShellView(baseProps({ people: [], pathname: "/settings" }));
    expect(findAllByType(element, TopBar).length).toBe(0);
  });

  it("does not disturb the normal path: an active profile still gets the top bar and the page", () => {
    const element = AppShellView(
      baseProps({ people: [userA], activeProfile: userA, pathname: "/settings" }),
    );
    expect(findAllByType(element, TopBar).length).toBe(1);
    expect(showsChildren(element)).toBe(true);
  });

  it("does not disturb the error branch", () => {
    const element = AppShellView(baseProps({ people: [], error: "boom", pathname: "/settings" }));
    expect(showsChildren(element)).toBe(false);
    expect(findAllByType(element, ProfilePicker).length).toBe(0);
  });

  it("does not disturb the still-loading branch", () => {
    const element = AppShellView(baseProps({ people: null, pathname: "/settings" }));
    expect(showsChildren(element)).toBe(false);
  });
});
