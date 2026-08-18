// src/components/profile-picker/ProfilePicker.tsx — the Netflix-style
// picker itself (DECISIONS.md "Profiles, not accounts"), plus T13's inline
// create form. Hook-free, so it's called directly as a function and its
// returned element tree inspected — see tests/helpers/react-element.ts's
// header for why that's a real proof of behaviour, not a rendering smoke
// test, without a DOM.
import { describe, expect, it } from "vitest";
import { ProfilePicker, type ProfilePickerProps } from "@/components/profile-picker/ProfilePicker";
import type { Profile } from "@/lib/profile/types";
import { findAllByType, findOneByType, walk } from "./helpers/react-element";

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };
const userB: Profile = { id: "user-b", displayName: "User B", avatar: "🙂", colour: "#00ff00" };

function baseProps(overrides: Partial<ProfilePickerProps> = {}): ProfilePickerProps {
  return {
    people: [],
    onChoose: () => {},
    onClose: undefined,
    createOpen: false,
    createDraft: "",
    creating: false,
    createError: null,
    onToggleCreate: () => {},
    onCreateDraftChange: () => {},
    onCreateSubmit: () => {},
    ...overrides,
  };
}

function textOf(element: unknown): string {
  return [...walk(element as never)]
    .map((el) => (el.props as { children?: unknown }).children)
    .filter((c) => typeof c === "string")
    .join(" ");
}

describe("ProfilePicker — choosing an existing profile", () => {
  it("renders one tile per profile, plus the add-profile tile", () => {
    const element = ProfilePicker(baseProps({ people: [userA, userB] }));
    const tiles = findAllByType(element, "button");
    // 2 profile tiles + 1 "Add profile" tile.
    expect(tiles.length).toBe(3);
  });

  it("clicking a tile calls onChoose with THAT profile, not always the first", () => {
    const chosen: Profile[] = [];
    const element = ProfilePicker(
      baseProps({ people: [userA, userB], onChoose: (p) => chosen.push(p) }),
    );
    const tiles = findAllByType(element, "button");
    // The second tile (User B) — proves the click handler is bound to the
    // specific person it was rendered for, not a stale/shared reference.
    (tiles[1]!.props as { onClick: () => void }).onClick();
    expect(chosen).toEqual([userB]);
  });

  it("shows the profile's own avatar when it has one", () => {
    const element = ProfilePicker(baseProps({ people: [userB] }));
    const text = [...walk(element)]
      .map((el) => el.props as { children?: unknown; "aria-hidden"?: string })
      .find((props) => props["aria-hidden"] === "true")?.children;
    expect(text).toBe("🙂");
  });

  it("falls back to the first letter of the display name when there is no avatar", () => {
    const element = ProfilePicker(baseProps({ people: [userA] }));
    const text = [...walk(element)]
      .map((el) => el.props as { children?: unknown; "aria-hidden"?: string })
      .find((props) => props["aria-hidden"] === "true")?.children;
    expect(text).toBe("U");
  });

  it("sets the tile's border colour from the profile's colour, when present", () => {
    const element = ProfilePicker(baseProps({ people: [userB] }));
    const tile = findAllByType(element, "button")[0]!;
    expect((tile.props as { style?: { borderColor?: string } }).style?.borderColor).toBe("#00ff00");
  });

  it("leaves the tile's style undefined when the profile has no colour", () => {
    const element = ProfilePicker(baseProps({ people: [userA] }));
    const tile = findAllByType(element, "button")[0]!;
    expect((tile.props as { style?: unknown }).style).toBeUndefined();
  });

  it("renders NO close button when onClose is not provided — the initial, uncancellable picker", () => {
    const element = ProfilePicker(baseProps({ people: [userA] }));
    const closeButtons = findAllByType(element, "button").filter(
      (el) => (el.props as { "aria-label"?: string })["aria-label"] === "Cancel",
    );
    expect(closeButtons.length).toBe(0);
  });

  it("renders a close button that calls onClose when it IS provided — the switch panel", () => {
    let closed = false;
    const element = ProfilePicker(
      baseProps({
        people: [userA],
        onClose: () => {
          closed = true;
        },
      }),
    );
    const closeButtons = findAllByType(element, "button").filter(
      (el) => (el.props as { "aria-label"?: string })["aria-label"] === "Cancel",
    );
    expect(closeButtons.length).toBe(1);
    (closeButtons[0]!.props as { onClick: () => void }).onClick();
    expect(closed).toBe(true);
  });
});

describe("ProfilePicker — T13's empty state is a create form, not a message", () => {
  it("shows the create form, not just a message, when there are no profiles", () => {
    const element = ProfilePicker(baseProps({ people: [] }));
    expect(textOf(element)).toContain("No profiles are set up yet");
    expect(findOneByType(element, "form")).toBeTruthy();
    expect(findOneByType(element, "input")).toBeTruthy();
  });

  it("renders no profile grid at all when the list is empty — the create form is the whole panel", () => {
    const element = ProfilePicker(baseProps({ people: [] }));
    expect(findAllByType(element, "ul").length).toBe(0);
  });

  it("the empty-state create form has no cancel button — there is nothing to cancel back to", () => {
    const element = ProfilePicker(baseProps({ people: [] }));
    const cancelButtons = findAllByType(element, "button").filter(
      (el) => (el.props as { children?: unknown }).children === "Cancel",
    );
    expect(cancelButtons.length).toBe(0);
  });

  it("submitting the empty-state form calls onCreateSubmit", () => {
    let submitted = false;
    const element = ProfilePicker(
      baseProps({ people: [], createDraft: "Ope", onCreateSubmit: () => (submitted = true) }),
    );
    const form = findOneByType(element, "form");
    const fakeEvent = { preventDefault: () => {} };
    (form.props as { onSubmit: (e: typeof fakeEvent) => void }).onSubmit(fakeEvent);
    expect(submitted).toBe(true);
  });

  it("typing into the name field calls onCreateDraftChange with the typed value", () => {
    let draft: string | undefined;
    const element = ProfilePicker(
      baseProps({ people: [], onCreateDraftChange: (v) => (draft = v) }),
    );
    const input = findOneByType(element, "input");
    (input.props as { onChange: (e: { target: { value: string } }) => void }).onChange({
      target: { value: "Tomi" },
    });
    expect(draft).toBe("Tomi");
  });

  it("disables the submit button while the draft is blank", () => {
    const element = ProfilePicker(baseProps({ people: [], createDraft: "" }));
    const submit = findAllByType(element, "button").find(
      (el) => (el.props as { type?: string }).type === "submit",
    )!;
    expect((submit.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it("disables the submit button while the draft is whitespace-only", () => {
    const element = ProfilePicker(baseProps({ people: [], createDraft: "   " }));
    const submit = findAllByType(element, "button").find(
      (el) => (el.props as { type?: string }).type === "submit",
    )!;
    expect((submit.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it("enables the submit button once the draft has non-whitespace content", () => {
    const element = ProfilePicker(baseProps({ people: [], createDraft: "Ope" }));
    const submit = findAllByType(element, "button").find(
      (el) => (el.props as { type?: string }).type === "submit",
    )!;
    expect((submit.props as { disabled?: boolean }).disabled).toBe(false);
  });

  it("disables the submit button and the name field while creating", () => {
    const element = ProfilePicker(baseProps({ people: [], createDraft: "Ope", creating: true }));
    const submit = findAllByType(element, "button").find(
      (el) => (el.props as { type?: string }).type === "submit",
    )!;
    const input = findOneByType(element, "input");
    expect((submit.props as { disabled?: boolean }).disabled).toBe(true);
    expect((input.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it("shows the pending label while creating", () => {
    const element = ProfilePicker(baseProps({ people: [], createDraft: "Ope", creating: true }));
    expect(textOf(element)).toContain("Creating…");
  });

  it("shows the create error message when present", () => {
    const element = ProfilePicker(
      baseProps({ people: [], createError: "displayName is required" }),
    );
    expect(textOf(element)).toContain("displayName is required");
  });

  it("shows no error message when createError is null", () => {
    const element = ProfilePicker(baseProps({ people: [], createError: null }));
    expect(textOf(element)).not.toContain("null");
  });
});

describe("ProfilePicker — create is also reachable once profiles exist", () => {
  it("renders an 'Add profile' tile alongside existing profiles when the form is closed", () => {
    const element = ProfilePicker(baseProps({ people: [userA], createOpen: false }));
    const addTile = findAllByType(element, "button").find(
      (el) => (el.props as { "aria-label"?: string })["aria-label"] === "Add profile",
    );
    expect(addTile).toBeTruthy();
  });

  it("clicking the 'Add profile' tile calls onToggleCreate", () => {
    let toggled = false;
    const element = ProfilePicker(
      baseProps({ people: [userA], createOpen: false, onToggleCreate: () => (toggled = true) }),
    );
    const addButton = findAllByType(element, "button").find(
      (el) => (el.props as { "aria-label"?: string })["aria-label"] === "Add profile",
    );
    expect(addButton).toBeTruthy();
    (addButton!.props as { onClick: () => void }).onClick();
    expect(toggled).toBe(true);
  });

  it("shows the create form instead of the add tile when createOpen is true", () => {
    const element = ProfilePicker(baseProps({ people: [userA], createOpen: true }));
    expect(textOf(element)).not.toContain("Add profile");
    expect(findOneByType(element, "form")).toBeTruthy();
  });

  it("still shows existing profile tiles alongside the open create form", () => {
    const element = ProfilePicker(baseProps({ people: [userA], createOpen: true }));
    expect(textOf(element)).toContain("User A");
  });

  it("the non-empty create form HAS a cancel button that calls onToggleCreate", () => {
    let toggled = false;
    const element = ProfilePicker(
      baseProps({ people: [userA], createOpen: true, onToggleCreate: () => (toggled = true) }),
    );
    const cancelButton = findAllByType(element, "button").find(
      (el) => (el.props as { children?: unknown }).children === "Cancel",
    );
    expect(cancelButton).toBeTruthy();
    (cancelButton!.props as { onClick: () => void }).onClick();
    expect(toggled).toBe(true);
  });

  it("does not show the standalone empty message once at least one profile exists", () => {
    const element = ProfilePicker(baseProps({ people: [userA], createOpen: false }));
    expect(textOf(element)).not.toContain("No profiles are set up yet");
  });
});
