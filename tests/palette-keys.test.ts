// What a keystroke means — `@/lib/palette/keys`.
//
// This is the module that decides whether a letter is a shortcut or a
// character, so its failure mode is not "the shortcut does not work" but
// "the shortcut fires while someone is typing a title". The assertions
// below are written against that: the guard cases outnumber the happy path
// deliberately.
import { describe, expect, it } from "vitest";
import { decideKey, isPaletteChord, type KeyContext } from "@/lib/palette/keys";
import { NAV_PREFIX } from "@/lib/palette/shortcuts";

/** The ordinary case: nothing open, focus not in a field. */
const IDLE: KeyContext = { typing: false, overlayOpen: false };

describe("isPaletteChord", () => {
  it("matches Ctrl+K and Meta+K, in either case", () => {
    expect(isPaletteChord({ key: "k", ctrlKey: true })).toBe(true);
    expect(isPaletteChord({ key: "k", metaKey: true })).toBe(true);
    // Shift held reports an upper-case key. A person mashing all three
    // modifiers should still get the palette.
    expect(isPaletteChord({ key: "K", metaKey: true, shiftKey: true })).toBe(true);
  });

  it("does not match a bare k, which is an ordinary character", () => {
    expect(isPaletteChord({ key: "k" })).toBe(false);
  });
});

describe("decideKey — the typing guard", () => {
  // The single most important behaviour in the module: `c` is both a
  // shortcut and a letter, and getting this wrong eats a keystroke out of
  // whatever the person was writing.
  it("ignores every single-key shortcut while focus is in a field", () => {
    for (const key of ["c", "/", "?", NAV_PREFIX]) {
      const decision = decideKey({ key }, null, { typing: true, overlayOpen: false });
      expect(decision.intent).toBeNull();
      expect(decision.handled).toBe(false);
    }
  });

  it("still opens the palette from inside a field, because the chord is not a character", () => {
    const decision = decideKey({ key: "k", metaKey: true }, null, {
      typing: true,
      overlayOpen: false,
    });
    expect(decision.intent).toEqual({ kind: "open-palette" });
    expect(decision.handled).toBe(true);
  });

  it("ignores single keys while an overlay owns the keyboard", () => {
    const decision = decideKey({ key: "c" }, null, { typing: false, overlayOpen: true });
    expect(decision.intent).toBeNull();
  });

  it("clears an armed prefix when focus moves into a field", () => {
    // `g`, then a click into a text box, then `b`. Firing here would be the
    // shortcut acting on an intention the person abandoned.
    const decision = decideKey({ key: "b" }, NAV_PREFIX, { typing: true, overlayOpen: false });
    expect(decision.intent).toBeNull();
    expect(decision.pendingPrefix).toBeNull();
  });
});

describe("decideKey — the g-prefixed sequences", () => {
  it("arms the prefix on g without navigating", () => {
    const decision = decideKey({ key: NAV_PREFIX }, null, IDLE);
    expect(decision.intent).toBeNull();
    expect(decision.pendingPrefix).toBe(NAV_PREFIX);
    // Claimed, so the `g` does not also reach the page underneath.
    expect(decision.handled).toBe(true);
  });

  it("navigates on the second key, to the href the route map holds", () => {
    // Asserted against the literal hrefs rather than by looking them up in
    // `NAV_ROUTES` — reading them from the same module the implementation
    // reads would pass identically if `NAV_SHORTCUT_KEYS` pointed every
    // letter at the same destination.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["h", "/"],
      ["b", "/board"],
      ["p", "/projects"],
      ["n", "/needs-you"],
      ["f", "/fleet"],
    ];
    for (const [key, href] of cases) {
      const decision = decideKey({ key }, NAV_PREFIX, IDLE);
      expect(decision.intent).toEqual({ kind: "navigate", href });
      expect(decision.pendingPrefix).toBeNull();
    }
  });

  it("spends the prefix on an unmapped second key rather than staying armed", () => {
    // `g` then `z`. Leaving `g` armed would make the NEXT unrelated key
    // navigate, which is a shortcut firing on a press the person did not
    // associate with one.
    const decision = decideKey({ key: "z" }, NAV_PREFIX, IDLE);
    expect(decision.intent).toBeNull();
    expect(decision.pendingPrefix).toBeNull();
    expect(decision.handled).toBe(false);
  });

  it("does not treat a modified second key as the sequence's completion", () => {
    // Ctrl+P is the browser's print dialog. Swallowing it as "go to
    // projects" would take a browser function away from the person.
    const decision = decideKey({ key: "p", ctrlKey: true }, NAV_PREFIX, IDLE);
    expect(decision.intent).toBeNull();
    expect(decision.handled).toBe(false);
  });
});

describe("decideKey — the single-key verbs", () => {
  it("maps c to create, / to search and ? to help", () => {
    expect(decideKey({ key: "c" }, null, IDLE).intent).toEqual({ kind: "open-create" });
    expect(decideKey({ key: "/" }, null, IDLE).intent).toEqual({ kind: "focus-search" });
    expect(decideKey({ key: "?" }, null, IDLE).intent).toEqual({ kind: "open-help" });
  });

  it("distinguishes ? from / rather than folding their case together", () => {
    // `?` is Shift+`/`. A case-insensitive match would make these two
    // presses indistinguishable and the help sheet would open on a search.
    const slash = decideKey({ key: "/" }, null, IDLE).intent;
    const question = decideKey({ key: "?", shiftKey: true }, null, IDLE).intent;
    expect(slash).not.toEqual(question);
    expect(question).toEqual({ kind: "open-help" });
  });

  it("leaves an unclaimed key entirely alone", () => {
    const decision = decideKey({ key: "q" }, null, IDLE);
    expect(decision.intent).toBeNull();
    // `handled: false` is what stops `preventDefault()` being called, so
    // this is the assertion that keeps every browser shortcut working.
    expect(decision.handled).toBe(false);
  });

  it("leaves a modified press to the browser", () => {
    for (const press of [
      { key: "c", ctrlKey: true },
      { key: "c", metaKey: true },
      { key: "c", altKey: true },
    ]) {
      expect(decideKey(press, null, IDLE).intent).toBeNull();
    }
  });
});
