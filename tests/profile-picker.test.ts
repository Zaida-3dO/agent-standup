// src/components/profile-picker/ProfilePicker.tsx — the Netflix-style
// picker itself (DECISIONS.md "Profiles, not accounts"). Hook-free, so it's
// called directly as a function and its returned element tree inspected —
// see tests/helpers/react-element.ts's header for why that's a real proof
// of behaviour, not a rendering smoke test, without a DOM.
import { describe, expect, it } from "vitest";
import { ProfilePicker } from "@/components/profile-picker/ProfilePicker";
import type { Profile } from "@/lib/profile/types";
import { findAllByType, findOneByType, walk } from "./helpers/react-element";

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };
const userB: Profile = { id: "user-b", displayName: "User B", avatar: "🙂", colour: "#00ff00" };

describe("ProfilePicker", () => {
  it("renders one tile per profile", () => {
    const element = ProfilePicker({ people: [userA, userB], onChoose: () => {}, onClose: undefined });
    const tiles = findAllByType(element, "button");
    expect(tiles.length).toBe(2);
  });

  it("renders zero tiles, and an empty message, for an empty profile list", () => {
    const element = ProfilePicker({ people: [], onChoose: () => {}, onClose: undefined });
    const tiles = findAllByType(element, "button");
    expect(tiles.length).toBe(0);
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).toContain("No profiles are set up yet.");
  });

  it("clicking a tile calls onChoose with THAT profile, not always the first", () => {
    const chosen: Profile[] = [];
    const element = ProfilePicker({
      people: [userA, userB],
      onChoose: (p) => chosen.push(p),
      onClose: undefined,
    });
    const tiles = findAllByType(element, "button");
    // The second tile (User B) — proves the click handler is bound to the
    // specific person it was rendered for, not a stale/shared reference.
    (tiles[1]!.props as { onClick: () => void }).onClick();
    expect(chosen).toEqual([userB]);
  });

  it("shows the profile's own avatar when it has one", () => {
    const element = ProfilePicker({ people: [userB], onChoose: () => {}, onClose: undefined });
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown; "aria-hidden"?: string }))
      .find((props) => props["aria-hidden"] === "true")?.children;
    expect(text).toBe("🙂");
  });

  it("falls back to the first letter of the display name when there is no avatar", () => {
    const element = ProfilePicker({ people: [userA], onChoose: () => {}, onClose: undefined });
    const text = [...walk(element)]
      .map((el) => el.props as { children?: unknown; "aria-hidden"?: string })
      .find((props) => props["aria-hidden"] === "true")?.children;
    expect(text).toBe("U");
  });

  it("sets the tile's border colour from the profile's colour, when present", () => {
    const element = ProfilePicker({ people: [userB], onChoose: () => {}, onClose: undefined });
    const tile = findOneByType(element, "button");
    expect((tile.props as { style?: { borderColor?: string } }).style?.borderColor).toBe("#00ff00");
  });

  it("leaves the tile's style undefined when the profile has no colour", () => {
    const element = ProfilePicker({ people: [userA], onChoose: () => {}, onClose: undefined });
    const tile = findOneByType(element, "button");
    expect((tile.props as { style?: unknown }).style).toBeUndefined();
  });

  it("renders NO close button when onClose is not provided — the initial, uncancellable picker", () => {
    const element = ProfilePicker({ people: [userA], onChoose: () => {}, onClose: undefined });
    const closeButtons = findAllByType(element, "button").filter(
      (el) => (el.props as { "aria-label"?: string })["aria-label"] === "Cancel",
    );
    expect(closeButtons.length).toBe(0);
  });

  it("renders a close button that calls onClose when it IS provided — the switch panel", () => {
    let closed = false;
    const element = ProfilePicker({
      people: [userA],
      onChoose: () => {},
      onClose: () => {
        closed = true;
      },
    });
    const closeButtons = findAllByType(element, "button").filter(
      (el) => (el.props as { "aria-label"?: string })["aria-label"] === "Cancel",
    );
    expect(closeButtons.length).toBe(1);
    (closeButtons[0]!.props as { onClick: () => void }).onClick();
    expect(closed).toBe(true);
  });
});
