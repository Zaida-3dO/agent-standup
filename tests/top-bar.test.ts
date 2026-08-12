// src/components/top-bar/TopBar.tsx — the existing chrome MILESTONES.md
// #35 asks the switcher to live in. Hook-free and prop-driven (see the
// component's own header for why), so it's called directly as a function —
// same technique as tests/profile-picker.test.ts.
import { describe, expect, it } from "vitest";
import { TopBar } from "@/components/top-bar/TopBar";
import type { Profile } from "@/lib/profile/types";
import { findAllByType, walk } from "./helpers/react-element";

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };
const userB: Profile = { id: "user-b", displayName: "User B", avatar: "🙂", colour: "#00ff00" };

describe("TopBar", () => {
  it("renders no switcher button when there is no active profile", () => {
    const element = TopBar({ activeProfile: null, onSwitchProfile: () => {} });
    expect(findAllByType(element, "button").length).toBe(0);
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
    const [button] = findAllByType(element, "button");
    (button!.props as { onClick: () => void }).onClick();
    expect(switched).toBe(true);
  });

  it("shows the profile's avatar when it has one, falling back to an initial otherwise", () => {
    const withAvatar = TopBar({ activeProfile: userB, onSwitchProfile: () => {} });
    const avatarText = [...walk(withAvatar)]
      .map((el) => el.props as { children?: unknown; "aria-hidden"?: string })
      .find((props) => props["aria-hidden"] === "true")?.children;
    expect(avatarText).toBe("🙂");

    const withoutAvatar = TopBar({ activeProfile: userA, onSwitchProfile: () => {} });
    const initialText = [...walk(withoutAvatar)]
      .map((el) => el.props as { children?: unknown; "aria-hidden"?: string })
      .find((props) => props["aria-hidden"] === "true")?.children;
    expect(initialText).toBe("U");
  });
});
