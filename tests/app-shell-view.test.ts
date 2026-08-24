// src/components/app-shell/AppShellView.tsx — the branch selection for
// MILESTONES.md #35's profile lifecycle. Hook-free and prop-driven (see
// the component's own header), so it's called directly as a function —
// same technique as tests/profile-picker.test.ts.
import { describe, expect, it } from "vitest";
import { AppShellView, type AppShellViewProps } from "@/components/app-shell/AppShellView";
import { ProfilePicker } from "@/components/profile-picker/ProfilePicker";
import { TopBar } from "@/components/top-bar/TopBar";
import { SidebarView } from "@/components/sidebar/SidebarView";
import type { Profile } from "@/lib/profile/types";
import { findAllByType, findOneByType, walk } from "./helpers/react-element";

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };
const userB: Profile = { id: "user-b", displayName: "User B", avatar: null, colour: "#00ff00" };

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

  // T22 — the SUPPLY site, not the rendering. `ProfilePicker` decides how a
  // current tile looks and is covered in
  // `tests/profile-selection-signal.test.ts`; what is asserted here is that
  // the shell actually hands it the active id. Without this, deleting the
  // `activeProfileId={activeProfile.id}` line leaves every picker test green
  // while no tile is ever marked in the running app — which is exactly the
  // failure mode the saved-view highlight shipped with.
  it("tells the switch picker WHICH profile is active", () => {
    const element = AppShellView(
      baseProps({ people: [userA, userB], activeProfile: userB, pickerOpen: true }),
    );
    const picker = findOneByType(element, ProfilePicker);
    // `userB`, not `people[0]` — a hard-coded first profile would pass an
    // assertion that only ever activated userA.
    expect((picker.props as { activeProfileId?: unknown }).activeProfileId).toBe(userB.id);
  });

  it("marks nothing on the INITIAL picker, where no profile is active yet", () => {
    // `activeProfile` is null here, so there is no honest answer to "which
    // one are you" — passing an id would be a claim that is simply false.
    const element = AppShellView(baseProps({ people: [userA], activeProfile: null }));
    const picker = findOneByType(element, ProfilePicker);
    expect((picker.props as { activeProfileId?: unknown }).activeProfileId ?? null).toBeNull();
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

describe("AppShellView — the application frame", () => {
  it("renders the sidebar, the top strip and the page once a profile is active", () => {
    const element = AppShellView(baseProps({ people: [userA], activeProfile: userA }));
    expect(findAllByType(element, SidebarView)).toHaveLength(1);
    expect(findAllByType(element, TopBar)).toHaveLength(1);
    expect(findAllByType(element, "main")).toHaveLength(1);
  });

  it("renders NO sidebar while the picker is gating the app", () => {
    // A rail offering eight destinations behind a gate that blocks seven of
    // them would be seven links to the picker.
    const element = AppShellView(baseProps({ people: [userA], activeProfile: null }));
    expect(findAllByType(element, SidebarView)).toHaveLength(0);
  });

  it("renders NO sidebar on the first-run escape either", () => {
    const element = AppShellView(
      baseProps({ people: [], activeProfile: null, pathname: "/settings" }),
    );
    expect(findAllByType(element, SidebarView)).toHaveLength(0);
    expect(findAllByType(element, "main")).toHaveLength(1);
  });

  it("hands the sidebar the counts it was given", () => {
    const element = AppShellView(
      baseProps({
        people: [userA],
        activeProfile: userA,
        counts: { unseen: 6, needsYou: 2 },
      }),
    );
    const sidebar = findOneByType(element, SidebarView);
    // Hardcoding the counts inside the shell rather than relaying them
    // fails this.
    expect((sidebar.props as { counts: unknown }).counts).toEqual({ unseen: 6, needsYou: 2 });
  });

  it("defaults the counts to zeroes rather than passing undefined down", () => {
    const element = AppShellView(baseProps({ people: [userA], activeProfile: userA }));
    const sidebar = findOneByType(element, SidebarView);
    expect((sidebar.props as { counts: unknown }).counts).toEqual({ unseen: 0, needsYou: 0 });
  });

  it("derives the breadcrumb from the path it was given", () => {
    const element = AppShellView(
      baseProps({ people: [userA], activeProfile: userA, pathname: "/board" }),
    );
    const topBar = findOneByType(element, TopBar);
    expect((topBar.props as { crumbs: unknown }).crumbs).toEqual([{ label: "Board", href: null }]);
  });

  it("passes no crumbs at all when the path is unknown", () => {
    // `crumbsFor(undefined)` would be a crash; an empty trail is the honest
    // answer to "where am I" before the router has said.
    const element = AppShellView(baseProps({ people: [userA], activeProfile: userA }));
    const topBar = findOneByType(element, TopBar);
    expect((topBar.props as { crumbs: unknown }).crumbs).toEqual([]);
  });

  it("relays the sheet's open state and its close handler to the sidebar", () => {
    let closed = 0;
    const element = AppShellView(
      baseProps({
        people: [userA],
        activeProfile: userA,
        navOpen: true,
        onCloseNav: () => void closed++,
      }),
    );
    const sidebar = findOneByType(element, SidebarView);
    expect((sidebar.props as { sheetOpen: boolean }).sheetOpen).toBe(true);
    (sidebar.props as { onCloseSheet: () => void }).onCloseSheet();
    expect(closed).toBe(1);
  });

  it("keeps the sheet closed by default", () => {
    const element = AppShellView(baseProps({ people: [userA], activeProfile: userA }));
    expect((findOneByType(element, SidebarView).props as { sheetOpen: boolean }).sheetOpen).toBe(
      false,
    );
  });

  it("relays the density value and toggle to the top strip", () => {
    let toggled = 0;
    const element = AppShellView(
      baseProps({
        people: [userA],
        activeProfile: userA,
        density: "compact",
        onToggleDensity: () => void toggled++,
      }),
    );
    const topBar = findOneByType(element, TopBar);
    expect((topBar.props as { density: unknown }).density).toBe("compact");
    (topBar.props as { onToggleDensity: () => void }).onToggleDensity();
    expect(toggled).toBe(1);
  });

  it("still opens the switch panel over the frame, without losing the sidebar", () => {
    // The profile picker's behaviour is unchanged by the move — it opens
    // over the page, and the frame stays put behind it.
    const element = AppShellView(
      baseProps({ people: [userA], activeProfile: userA, pickerOpen: true }),
    );
    expect(findAllByType(element, ProfilePicker)).toHaveLength(1);
    expect(findAllByType(element, SidebarView)).toHaveLength(1);
    expect(findAllByType(element, "main")).toHaveLength(1);
  });
});
