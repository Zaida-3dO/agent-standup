// The one structural fact the overlay-suppression fix rests on, pinned.
//
// `UndoToastHost` reads `usePalette().overlayOpen` to know when a modal is
// covering it. That hook resolves to the real value only because `AppShell`
// renders `PaletteHost` OUTSIDE `UndoToastHost`. Nested the other way, the
// hook returns `NO_PALETTE` — whose `overlayOpen` is `false` and stays false —
// and the whole feature becomes silently inert: no error, no warning, every
// unit test still green, and the toast back to expiring behind a backdrop.
//
// **That is not a hypothetical failure mode in this repo.** A related fix
// went inert in exactly this way in #277, because a hook was placed on the
// wrong side of the provider that fed it. The nesting was checked by hand
// before this fix was written; this test is what stops the next person
// reordering it back.
//
// ── Why this asserts on the source rather than on a render ──────────────
//
// `AppShell` is a client component that reads profile context, fetches nav
// counts and renders the whole shell; mounting it to observe two providers'
// relative position would need most of the app stood up, and would still be
// asserting the arrangement indirectly. The arrangement is a syntactic fact
// about one file, so it is checked as one. The behaviour that DEPENDS on the
// arrangement is covered by mounting, in
// `tests/undo-toast-overlay-suppression.test.ts` — which mounts the two hosts
// in this order and would fail if the contract between them broke. The two
// together are what cover the risk: this one says the shell uses that order,
// that one says the order works.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SHELL = path.join(process.cwd(), "src/components/app-shell/AppShell.tsx");

describe("AppShell's provider nesting", () => {
  it("mounts PaletteHost outside UndoToastHost, so the toast can read overlay state", () => {
    const source = readFileSync(SHELL, "utf8");

    const paletteOpen = source.indexOf("<PaletteHost>");
    const toastOpen = source.indexOf("<UndoToastHost>");
    const toastClose = source.indexOf("</UndoToastHost>");
    const paletteClose = source.indexOf("</PaletteHost>");

    // Each element is present exactly where expected before the ordering
    // below means anything — a `-1` from a renamed component would otherwise
    // satisfy `<` comparisons by accident and report success.
    expect(paletteOpen).toBeGreaterThanOrEqual(0);
    expect(toastOpen).toBeGreaterThan(0);
    expect(toastClose).toBeGreaterThan(0);
    expect(paletteClose).toBeGreaterThan(0);

    // Strictly nested: palette opens first and closes last.
    expect(paletteOpen).toBeLessThan(toastOpen);
    expect(toastClose).toBeLessThan(paletteClose);
  });
});
