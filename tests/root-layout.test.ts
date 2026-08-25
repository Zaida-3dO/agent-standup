// src/app/layout.tsx and src/app/page.tsx — the app root. Both are
// hook-free (RootLayout only composes elements; ProfileProvider/AppShell
// are referenced as types, never invoked), so they're called directly as
// functions — same technique as tests/profile-picker.test.ts.
import { describe, expect, it } from "vitest";
import RootLayout, { metadata } from "@/app/layout";
import Home from "@/app/page";
import BoardPage from "@/app/board/page";
import { ProfileProvider } from "@/lib/profile/ProfileProvider";
import { AppShell } from "@/components/app-shell/AppShell";
import { Board } from "@/components/board/Board";
import { BoardSurface } from "@/components/board/BoardSurface";
import { Landing } from "@/components/landing/Landing";
import type { ReactNode } from "react";
import { findOneByType, walk } from "./helpers/react-element";

describe("metadata", () => {
  it("names the app in the title and description", () => {
    expect(metadata.title).toBe("Agent Standup");
    expect(metadata.description).toBe("A task tracker for AI coding agents.");
  });
});

describe("RootLayout", () => {
  it("wraps its children in ProfileProvider then AppShell, in that order", () => {
    const element = RootLayout({ children: "the page" });
    const provider = findOneByType(element, ProfileProvider);
    const shell = findOneByType(element, AppShell);
    // ProfileProvider must be the outer boundary: AppShell (and everything
    // it renders) calls useProfile(), which needs the context ABOVE it.
    const providerChildren = (provider.props as { children: ReactNode }).children;
    expect([...walk(providerChildren)]).toContain(shell);
  });

  it("passes the given children all the way down to AppShell", () => {
    const element = RootLayout({ children: "the page" });
    const shell = findOneByType(element, AppShell);
    expect((shell.props as { children: unknown }).children).toBe("the page");
  });

  it('declares lang="en" on the html element', () => {
    const element = RootLayout({ children: "x" });
    expect((element.props as { lang?: string }).lang).toBe("en");
  });
});

describe("Home", () => {
  // The root is a CHOICE, not a screen: `ui.default_landing` decides what
  // it shows, and `Landing` is the component that reads the setting and
  // either renders the digest in place or redirects. The decision itself is
  // tested in tests/nav-landing.test.ts; this only proves the root places
  // the chooser and nothing else.
  it("renders the landing chooser", () => {
    expect(findOneByType(Home(), Landing)).toBeDefined();
  });

  it("does NOT render the board directly — the kanban moved to /board", () => {
    // Reverting `src/app/page.tsx` to render `Board` fails this, which is
    // the point: the root and the board are now different addresses.
    expect([...walk(Home())].filter((el) => el.type === Board)).toHaveLength(0);
  });

  it("adds no wrapping <main> of its own — AppShell already supplies one", () => {
    expect(Home().type).not.toBe("main");
  });
});

describe("BoardPage", () => {
  // The kanban survives the move unchanged; only its address changed.
  it("renders the board surface at /board", () => {
    // `BoardSurface` rather than `Board` directly: `/board` serves two
    // shapes now — the kanban and the list — and the `layout` parameter
    // picks between them (MILESTONES.md T6 §3). The kanban is still what
    // an unparameterised `/board` renders; the choice simply happens one
    // level down, which is what `tests/board-list-view.test.ts` and
    // `tests/board-layout-url.test.ts` cover.
    expect(findOneByType(BoardPage(), BoardSurface)).toBeDefined();
  });

  it("adds no wrapping <main> of its own — AppShell already supplies one", () => {
    expect(BoardPage().type).not.toBe("main");
  });
});
