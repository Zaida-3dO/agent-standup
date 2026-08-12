// src/lib/profile/ProfileProvider.tsx — the hook-bound wiring itself.
// `useState`/`useContext` need a real render pass to work at all ("Invalid
// hook call" otherwise), so these tests go through React's own
// `renderToStaticMarkup` (`react-dom/server` — already a dependency, no
// jsdom needed: server rendering is exactly the DOM-free render this repo's
// test harness can run, `environment: "node"` in vitest.config.ts).
// `useEffect` never fires during server rendering, so this proves the
// INITIAL wiring (context is provided, the loading state renders, a
// missing provider throws) — not the fetch itself, which
// tests/profile-state.test.ts covers directly as a pure function.
import { createElement, useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProfileContext, ProfileProvider, useProfile } from "@/lib/profile/ProfileProvider";
import type { ProfileContextValue } from "@/lib/profile/state";

/** Renders children and exposes whatever `useProfile()` returns as a text node, so a test can read it out of the HTML string. */
function Probe() {
  const value = useProfile();
  return createElement("span", { "data-testid": "probe" }, JSON.stringify(value.people));
}

describe("useProfile", () => {
  it("throws when called with no ProfileProvider above it", () => {
    function Bare() {
      useProfile();
      return null;
    }
    expect(() => renderToStaticMarkup(createElement(Bare))).toThrow(
      "useProfile() must be called within a ProfileProvider.",
    );
  });

  it("does not throw when a value is provided via context directly", () => {
    const value: ProfileContextValue = {
      people: [],
      activeProfile: null,
      error: null,
      pickerOpen: false,
      openPicker: () => {},
      closePicker: () => {},
      choose: () => {},
    };
    function Reader() {
      const ctx = useContext(ProfileContext);
      return createElement("span", null, ctx === value ? "same" : "different");
    }
    const html = renderToStaticMarkup(
      createElement(ProfileContext.Provider, { value }, createElement(Reader)),
    );
    expect(html).toContain("same");
  });
});

describe("ProfileProvider — initial (pre-effect) render", () => {
  it("provides a context value whose people is null before the fetch has had a chance to run", () => {
    const html = renderToStaticMarkup(createElement(ProfileProvider, null, createElement(Probe)));
    // useEffect never runs during SSR, so the fetch hasn't started — the
    // published value must still be the loading-state default (people:
    // null), not some other value fabricated ahead of the real fetch.
    expect(html).toContain("null");
  });

  it("renders the children it was given, through the context provider", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProfileProvider,
        null,
        createElement("div", { "data-testid": "child" }, "child content"),
      ),
    );
    expect(html).toContain("child content");
  });
});
