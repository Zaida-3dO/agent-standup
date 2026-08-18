// src/components/app-shell/AppShell.tsx — the thin container that reads
// `useProfile()` and relays it to `AppShellView` as props. Needs a real
// render pass for the hook to work at all, so this goes through
// `renderToStaticMarkup` with a controlled `ProfileContext.Provider` value
// (same technique as tests/profile-provider.test.ts) rather than calling
// the component directly — proving the actual relay, not just that
// `AppShellView`'s own branches work (that's tests/app-shell-view.test.ts).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "@/components/app-shell/AppShell";
import { ProfileContext } from "@/lib/profile/ProfileProvider";
import type { ProfileContextValue } from "@/lib/profile/state";
import type { Profile } from "@/lib/profile/types";

const userA: Profile = { id: "user-a", displayName: "User A", avatar: null, colour: null };

function baseValue(overrides: Partial<ProfileContextValue> = {}): ProfileContextValue {
  return {
    people: null,
    activeProfile: null,
    error: null,
    pickerOpen: false,
    openPicker: () => {},
    closePicker: () => {},
    choose: () => {},
    addPerson: () => {},
    ...overrides,
  };
}

function renderUnder(value: ProfileContextValue, children: string): string {
  return renderToStaticMarkup(
    createElement(
      ProfileContext.Provider,
      { value },
      createElement(AppShell, null, createElement("span", null, children)),
    ),
  );
}

describe("AppShell", () => {
  it("relays an error from context through to the rendered output", () => {
    const html = renderUnder(baseValue({ error: "network down" }), "page content");
    expect(html).toContain("network down");
    expect(html).not.toContain("page content");
  });

  it("relays the loading state (people still null, no error) through to the rendered output", () => {
    const html = renderUnder(baseValue(), "page content");
    expect(html).toContain("Loading profiles");
  });

  it("relays a loaded, active profile through — the top bar and children both appear", () => {
    const html = renderUnder(baseValue({ people: [userA], activeProfile: userA }), "page content");
    expect(html).toContain("User A");
    expect(html).toContain("page content");
  });

  it("relays no-active-profile through — the picker, not the children", () => {
    const html = renderUnder(baseValue({ people: [userA], activeProfile: null }), "page content");
    expect(html).toContain("Who&#x27;s working?");
    expect(html).not.toContain("page content");
  });
});
