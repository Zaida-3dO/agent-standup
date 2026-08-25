// @vitest-environment jsdom
//
// **The undo toast and a modal overlay, composed in real React** — the third
// file in this suite to mount components, and it exists because the defect it
// covers is invisible to every other layer.
//
// ── What went wrong, and why no unit test could see it ──────────────────
//
// A visual review measured, with `document.elementFromPoint` at the centre of
// the Undo button while quick create was open, that the topmost element there
// is the dialog's backdrop. The toast renders at `z-index: 50` and the
// backdrop at `60`, so the affordance was visible through the scrim, counting
// down, and completely unpressable. The ten-second window expired unusable.
//
// Every pure function involved was correct. `ticked` expires the right state,
// `remainingMs` returns the right number, `undoPressed` refuses the right
// presses. The defect was in what those functions were being *given* — a wall
// clock, in a situation where the person could not act — and in the fact that
// two components in different parts of the tree had to agree about it. That
// is a composition, so this is a composition test.
//
// ── Why this mounts BOTH hosts, in the shell's real order ───────────────
//
// The single most load-bearing fact in the fix is that `AppShell` renders
// `PaletteHost` OUTSIDE `UndoToastHost`, so the toast is inside the palette's
// provider and `usePalette()` resolves to the real value. Nested the other
// way, the hook would read `NO_PALETTE` — `overlayOpen: false`, forever — and
// the entire feature would be silently inert while every unit test stayed
// green. A related fix went inert exactly that way in #277.
//
// So these tests do not stub the palette context. They mount the real
// `PaletteHost` wrapping the real `UndoToastHost` and drive the overlay
// through `usePalette().openCreate()`, which is the same call the `+` button
// and the `c` shortcut make. If someone reorders the two hosts in `AppShell`,
// `tests/app-shell-overlay-nesting.test.ts` fails; if someone breaks the
// contract between them, these fail.
import { createElement, StrictMode, useEffect } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UndoToastHost, useUndo } from "@/components/toast/UndoToastHost";
import { PaletteHost, usePalette } from "@/components/palette/PaletteHost";
import { UNDO_WINDOW_MS, type UndoableAction } from "@/lib/undo";

/** Every transition POST that reached the stubbed network. */
const transitionCalls: { url: string; body: unknown }[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  transitionCalls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/transition")) {
        transitionCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as unknown });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ item: { id: "item-a", state: "on_deck" } }),
        } as Response);
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A move that really changed something, so its inverse is available. */
function aMove(at: number): UndoableAction {
  return {
    kind: "state-change",
    at,
    move: { itemId: "item-a", from: "on_deck", to: "executing" },
    itemTitle: "A card",
  };
}

/**
 * The handles a test needs to drive the composition from the inside: offer an
 * undo, and open or close the overlay, both through the real public hooks.
 *
 * Collected from a child component rather than passed in, because the whole
 * point is to exercise the same context both features expose to the rest of
 * the app.
 */
interface Handles {
  offer: (action: UndoableAction) => void;
  openCreate: () => void;
}

const handles: Handles = { offer: () => {}, openCreate: () => {} };

/**
 * Sits inside both providers and publishes their APIs to the test.
 *
 * Deliberately renders nothing and offers nothing on mount — each test
 * decides when the action happens, because the ORDER of offer and open is
 * the substance of two of the cases below.
 */
function Harness() {
  const { offer } = useUndo();
  const { openCreate } = usePalette();
  // Republished whenever either identity changes, rather than captured once
  // behind a ref written during render — which `react-hooks/refs` refuses,
  // and rightly: a render is not the place to record anything. Both values
  // are stable `useCallback`s in their hosts, so this settles immediately.
  useEffect(() => {
    handles.offer = offer;
    handles.openCreate = openCreate;
  }, [offer, openCreate]);
  return null;
}

/**
 * Mounts the two hosts in the order `AppShell` mounts them — palette outside,
 * toast inside — under StrictMode.
 */
async function mountShell(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          PaletteHost,
          null,
          createElement(UndoToastHost, null, createElement(Harness)),
        ),
      ),
    );
  });
}

/** The toast's Undo button, or null when none is rendered. */
function undoButton(): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("Undo"),
    ) ?? null
  );
}

/** The quick-create dialog, or null when it is not open. */
function dialog(): HTMLElement | null {
  return container.querySelector('[role="dialog"]');
}

/** The toast's dismiss (×) button, or null when no toast is rendered. */
function dismissButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss notification"]');
}

/** The toast's offered region, or null when it is not showing one. */
function offeredToast(): HTMLElement | null {
  return container.querySelector('[data-phase="offered"]');
}

/** The countdown as an integer number of seconds, or null when absent. */
function secondsLeft(): number | null {
  const text = undoButton()?.textContent ?? "";
  const match = /(\d+)s/.exec(text);
  return match === null ? null : Number(match[1]);
}

describe("an undo offered while a modal overlay is open", () => {
  it("renders the toast with a countdown when nothing is covering it, so the assertions below are not vacuous", async () => {
    // Guards the guard, the way `undo-toast-host-wiring.test.ts` does. Every
    // test below turns on the toast being suppressed or restored; if it
    // stopped rendering altogether they would pass by asserting absence
    // against something that was never there.
    await mountShell();
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });

    expect(offeredToast()).not.toBeNull();
    expect(undoButton()).not.toBeNull();
    expect(secondsLeft()).toBe(10);
    expect(dialog()).toBeNull();
  });

  it("removes the toast from the document while the overlay is open", async () => {
    // **The visible half of the fix.** Before it, the toast stayed in the
    // DOM underneath the backdrop: present, counting, and unreachable. Left
    // rendered, it is also announced by a screen reader as a status region
    // containing a button nobody can operate.
    //
    // Restoring the defect — dropping the `overlayOpen ? null :` guard on
    // the `<UndoToast>` element — makes this fail on the first assertion,
    // because the toast is then in the document exactly as it was.
    await mountShell();
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });
    expect(offeredToast()).not.toBeNull();

    await act(async () => {
      handles.openCreate();
    });

    expect(dialog()).not.toBeNull();
    expect(offeredToast()).toBeNull();
    expect(undoButton()).toBeNull();
  });

  it("brings the same offer back, still undoable, after the overlay closes", async () => {
    // **The behavioural half, and the whole reason the window pauses.**
    //
    // The overlay is held open for four times the entire window. If the
    // countdown kept running behind it — the "suppress but keep ticking"
    // answer — `ticked` would have driven the toast to `idle` long before
    // the dialog closed, and the person would return to no offer at all:
    // the same loss the row was raised for, differently shaped.
    //
    // Restoring that behaviour (passing `now` rather than `effectiveNow` to
    // `ticked`) makes this fail: there is no toast and no button.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mountShell();
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });

    await act(async () => {
      handles.openCreate();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 4);
    });

    // Escape closes the overlay — the real close path, through the palette's
    // own focus trap, rather than a handle the test invented.
    await act(async () => {
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(dialog()).toBeNull();
    expect(offeredToast()).not.toBeNull();
    expect(undoButton()).not.toBeNull();
  });

  it("does not spend the window while the overlay is open", async () => {
    // Sharper than the test above: it is not enough that the offer survives,
    // it must survive with the time it had. Half the window is spent before
    // the dialog opens, the dialog is then held open for a further full
    // window, and the countdown afterwards must still read about five
    // seconds rather than having burned through.
    //
    // A one-character break — `windowClock` returning `nowMs + suspendedMs(...)`
    // instead of `nowMs - suspendedMs(...)` — makes this read a nonsense
    // value rather than ~5, and an unchanged `nowMs` makes it 0/absent.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mountShell();
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS / 2);
    });
    const beforeOverlay = secondsLeft();
    expect(beforeOverlay).toBe(5);

    await act(async () => {
      handles.openCreate();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS);
    });
    await act(async () => {
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    // The same five seconds it had when the dialog went up. Compared with a
    // tolerance of one second because the countdown is `Math.ceil`d and the
    // fake clock advances in whole ticks.
    const afterOverlay = secondsLeft();
    expect(afterOverlay).not.toBeNull();
    expect(Math.abs((afterOverlay ?? 0) - 5)).toBeLessThanOrEqual(1);
  });

  it("sends the transition when the restored offer is actually pressed", async () => {
    // **The acceptance criterion, end to end.** Everything above could hold
    // while the button still did nothing — the row is about an affordance
    // that looked live and was not, so the test that closes it has to press
    // the thing and watch a request leave.
    //
    // This is also where the second, subtler half of the fix is proved.
    // `onUndo` re-checks the window against the clock at the moment of the
    // press. If that check used the raw wall clock, this press — landing
    // well past ten wall-clock seconds after the action — would be refused
    // by `undoPressed`, and the count below would be 0 while the button sat
    // there showing time remaining. Deleting the `windowClock(...)` wrapper
    // in `onUndo` and passing `pressedAt` directly reproduces exactly that.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mountShell();
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });

    await act(async () => {
      handles.openCreate();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 3);
    });
    await act(async () => {
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    const button = undoButton();
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });

    expect(transitionCalls).toHaveLength(1);
    expect(transitionCalls[0]?.body).toEqual({ to: "on_deck", expectedFrom: "executing" });
  });

  it("still expires an offer the person left alone with no overlay open", async () => {
    // The guard on the guard: pausing must not become never-expiring. With
    // nothing suspending it, the window runs out exactly as it always did.
    //
    // This is the test that fails if someone "fixes" a suspension bug by
    // making `windowClock` return a constant.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mountShell();
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });
    expect(offeredToast()).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 1_000);
    });

    expect(offeredToast()).toBeNull();
    expect(undoButton()).toBeNull();
  });

  it("expires an offer that was suspended once and then left alone after the overlay closed", async () => {
    // **The narrower guard on the pause, and the one that caught a real
    // survivor.** The test above only covers an offer that was NEVER
    // suspended, so an implementation that froze the window permanently the
    // first time an overlay opened — `windowClock` returning `since` once
    // set, rather than resuming — passed the whole suite. The offer would
    // then sit there forever, undoable hours later against an item long
    // since moved.
    //
    // This holds the dialog open briefly, closes it, and then waits out the
    // rest of the window with nothing suspending anything. The clock must be
    // running again.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mountShell();
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });
    await act(async () => {
      handles.openCreate();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await act(async () => {
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    // Back, and still live — the pause worked.
    expect(offeredToast()).not.toBeNull();

    // Now let the remaining window run out with nothing covering the toast.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 1_000);
    });

    expect(offeredToast()).toBeNull();
    expect(undoButton()).toBeNull();
  });

  it("does not carry one action's suspended time into the next action's window", async () => {
    // **The guard on the tag, and a survivor the first pass missed.**
    //
    // The suspension is keyed on the action it was accumulated for. Without
    // that key, a long dialog session would bank (say) thirty seconds of
    // pause, and the NEXT undo — offered after the dialog closed, with
    // nothing suspending it — would be judged against a clock thirty seconds
    // behind the wall. It would sit there refusing to expire long after its
    // ten seconds were up: an offer the person could take back minutes
    // later, against an item that had moved on.
    //
    // Dropping the `banked.action === offeredForWindow` comparison (treating
    // any banked suspension as the current one's) makes this fail: the
    // second toast is still on screen at the end.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mountShell();

    // A first action, suspended for well over a window, then released.
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });
    await act(async () => {
      handles.openCreate();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS * 3);
    });
    await act(async () => {
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    // Dismissed rather than left to expire, so the second offer is the only
    // thing in play and this is not merely re-testing the first.
    await act(async () => {
      dismissButton()?.click();
    });

    // A second, entirely separate action, with nothing suspending it.
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });
    expect(offeredToast()).not.toBeNull();

    // It gets its own ten seconds and no more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS + 1_000);
    });

    expect(offeredToast()).toBeNull();
    expect(undoButton()).toBeNull();
  });

  it("gives an action offered while the overlay is already open its full window when it closes", async () => {
    // The other order, which is a real path rather than a contrived one: the
    // palette's own verbs act on an item and could offer an undo while the
    // overlay that triggered them is still up. That offer must not begin
    // burning its window before anyone can see it.
    //
    // `offer`'s branch on `overlayOpen` is what makes this pass; deleting it
    // (always resetting to `NO_SUSPENSION`) makes the offer count down
    // behind the dialog and arrive with ~5s rather than ~10s.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mountShell();

    await act(async () => {
      handles.openCreate();
    });
    await act(async () => {
      handles.offer(aMove(Date.now()));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNDO_WINDOW_MS / 2);
    });
    await act(async () => {
      dialog()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(offeredToast()).not.toBeNull();
    const left = secondsLeft();
    expect(left).not.toBeNull();
    expect(Math.abs((left ?? 0) - 10)).toBeLessThanOrEqual(1);
  });
});
