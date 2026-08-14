// src/lib/settings-page/first-run.ts — MILESTONES.md #86's "first-run entry
// when no profiles exist".
//
// The rule is a conjunction, and both halves are load-bearing, so the tests
// are written to catch either being dropped: an escape that fired on the
// path alone would let anyone reach `/settings` unattributed on a populated
// installation, and one that fired on the state alone would show the board
// with nobody working on it.
import { describe, expect, it } from "vitest";
import { allowsWithoutProfile, isFirstRun, isFirstRunPath } from "@/lib/settings-page/first-run";

const somebody = { id: "user-a" };

describe("recognising a first run", () => {
  it("is a first run when the list has loaded and is empty with nothing active", () => {
    expect(isFirstRun({ people: [], activeProfile: null })).toBe(true);
  });

  it("is not a first run while the list has not loaded", () => {
    // Answering "yes" here would flash the escape hatch on every page load
    // before the fetch returns.
    expect(isFirstRun({ people: null, activeProfile: null })).toBe(false);
  });

  it("is not a first run when profiles exist but none is chosen", () => {
    // The picker works in this state, so blocking is correct.
    expect(isFirstRun({ people: [somebody], activeProfile: null })).toBe(false);
  });

  it("is not a first run when the remembered profile is stale but others exist", () => {
    // A stale remembered id also resolves to activeProfile: null, but leaves
    // a non-empty list — the picker has something to offer.
    expect(isFirstRun({ people: [somebody], activeProfile: null })).toBe(false);
  });

  it("is not a first run once a profile is active", () => {
    expect(isFirstRun({ people: [somebody], activeProfile: somebody })).toBe(false);
  });
});

describe("which paths the escape covers", () => {
  it("covers the settings page and the administration pages", () => {
    expect(isFirstRunPath("/settings")).toBe(true);
    expect(isFirstRunPath("/admin")).toBe(true);
  });

  it("covers a page beneath one of them", () => {
    expect(isFirstRunPath("/admin/repos")).toBe(true);
    expect(isFirstRunPath("/settings/anything")).toBe(true);
  });

  it("does not cover the board", () => {
    // The board is the thing the picker exists to attribute; showing it
    // unattributed would make "who's working" a question the app had quietly
    // stopped asking.
    expect(isFirstRunPath("/")).toBe(false);
  });

  it("does not cover a path that merely starts with the same characters", () => {
    // A bare prefix test would open anything somebody later named with that
    // stem.
    expect(isFirstRunPath("/settings-export")).toBe(false);
    expect(isFirstRunPath("/administration")).toBe(false);
  });
});

describe("the combined decision needs both halves", () => {
  it("allows the settings page on a first run", () => {
    expect(allowsWithoutProfile({ people: [], activeProfile: null }, "/settings")).toBe(true);
  });

  it("refuses the settings page when profiles exist", () => {
    expect(allowsWithoutProfile({ people: [somebody], activeProfile: null }, "/settings")).toBe(
      false,
    );
  });

  it("refuses the board even on a first run", () => {
    expect(allowsWithoutProfile({ people: [], activeProfile: null }, "/")).toBe(false);
  });

  it("refuses everything while the profile list is still loading", () => {
    expect(allowsWithoutProfile({ people: null, activeProfile: null }, "/settings")).toBe(false);
  });
});
