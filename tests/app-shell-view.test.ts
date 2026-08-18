// src/components/app-shell/AppShellView.tsx — the branch selection for
// MILESTONES.md #35's profile lifecycle. Hook-free and prop-driven (see
// the component's own header), so it's called directly as a function —
// same technique as tests/profile-picker.test.ts.
import { describe, expect, it } from "vitest";
import { AppShellView, type AppShellViewProps } from "@/components/app-shell/AppShellView";
import { ProfilePicker } from "@/components/profile-picker/ProfilePicker";
import { TopBar } from "@/components/top-bar/TopBar";
import type { Profile } from "@/lib/profile/types";
import { findAllByType, findOneByType, walk } from "./helpers/react-element";

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
    createOpen: false,
    createDraft: "",
    creating: false,
    createError: null,
    onToggleCreate: () => {},
    onCreateDraftChange: () => {},
    onCreateSubmit: () => {},
    children: "page content",
    ...overrides,
  };
}

describe("AppShellView", () => {
  it("shows the error message when GET /api/people failed, even if people somehow loaded too", () => {
    const element = AppShellView(baseProps({ error: "boom", people: [] }));
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).toContain("boom");
    // The error branch wins — no top bar, no picker underneath it.
    expect(findAllByType(element, TopBar).length).toBe(0);
  });

  it("shows a loading state while people is still null and there is no error", () => {
    const element = AppShellView(baseProps({ people: null, error: null }));
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).toContain("Loading profiles");
  });

  it("shows the picker, not the top bar or children, when no profile is active — no-profile-chosen-yet", () => {
    const element = AppShellView(baseProps({ people: [userA], activeProfile: null }));
    expect(findAllByType(element, ProfilePicker).length).toBe(1);
    expect(findAllByType(element, TopBar).length).toBe(0);
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).not.toContain("page content");
  });

  it("the forced picker (no active profile) has no onClose — nothing to cancel back to", () => {
    const element = AppShellView(baseProps({ people: [userA], activeProfile: null }));
    const picker = findOneByType(element, ProfilePicker);
    expect((picker.props as { onClose?: unknown }).onClose).toBeUndefined();
  });

  it("shows the top bar and children once a profile is active, with the picker closed by default", () => {
    const element = AppShellView(
      baseProps({ people: [userA], activeProfile: userA, pickerOpen: false }),
    );
    expect(findAllByType(element, TopBar).length).toBe(1);
    expect(findAllByType(element, ProfilePicker).length).toBe(0);
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).toContain("page content");
  });

  it("shows the switch picker (WITH onClose) over the page when pickerOpen is true", () => {
    const element = AppShellView(
      baseProps({ people: [userA], activeProfile: userA, pickerOpen: true }),
    );
    const picker = findOneByType(element, ProfilePicker);
    expect(typeof (picker.props as { onClose?: unknown }).onClose).toBe("function");
    // Children are still present underneath — switching is cancellable, not
    // a full-page replacement like the initial picker.
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).toContain("page content");
  });

  it("the top bar's switch action is wired to openPicker", () => {
    let opened = false;
    const element = AppShellView(
      baseProps({
        people: [userA],
        activeProfile: userA,
        openPicker: () => {
          opened = true;
        },
      }),
    );
    const topBar = findOneByType(element, TopBar);
    (topBar.props as { onSwitchProfile: () => void }).onSwitchProfile();
    expect(opened).toBe(true);
  });

  // T21 — a follow-up from #175's review: `ProfileProvider`'s
  // `fetchPeople()` runs once on mount, and (before this fix) `choose`
  // never touched `people`, so creating the FIRST profile in a session left
  // `people` stale at `[]` even though `activeProfile` was the profile just
  // created. Opening the switcher in that state showed "No profiles are
  // set up yet" over a profile that plainly exists. This is the exact
  // shape the reviewer's own probe against the real components used to
  // confirm the bug — reproduced here as the regression test, with `people`
  // now containing the created row (what `addPerson` lands): flip it back
  // to `people: []` and this fails, proving the test would have caught the
  // original bug.
  it("does not show the empty-picker message when the switcher is opened right after creating the first profile", () => {
    const created: Profile = {
      id: "user-new",
      displayName: "Newly Created",
      avatar: null,
      colour: null,
    };
    const element = AppShellView(
      baseProps({ people: [created], activeProfile: created, pickerOpen: true }),
    );
    const picker = findOneByType(element, ProfilePicker);
    expect((picker.props as { people: readonly Profile[] }).people).toContain(created);
    const text = [...walk(element)]
      .map((el) => (el.props as { children?: unknown }).children)
      .filter((c) => typeof c === "string")
      .join(" ");
    expect(text).not.toContain("No profiles are set up yet");
  });
});
