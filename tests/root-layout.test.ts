// src/app/layout.tsx and src/app/page.tsx — the app root. Both are
// hook-free (RootLayout only composes elements; ProfileProvider/AppShell
// are referenced as types, never invoked), so they're called directly as
// functions — same technique as tests/profile-picker.test.ts.
import { describe, expect, it } from "vitest";
import RootLayout, { metadata } from "@/app/layout";
import Home from "@/app/page";
import { ProfileProvider } from "@/lib/profile/ProfileProvider";
import { AppShell } from "@/components/app-shell/AppShell";
import { Board } from "@/components/board/Board";
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
  // The home page is the board (MILESTONES.md #37). It renders `Board` and
  // nothing else — the branching lives in `BoardView`, which is tested
  // directly in tests/board-view-component.test.ts.
  it("renders the board", () => {
    expect(findOneByType(Home(), Board)).toBeDefined();
  });

  it("adds no wrapping <main> of its own — AppShell already supplies one", () => {
    expect(Home().type).not.toBe("main");
  });
});
