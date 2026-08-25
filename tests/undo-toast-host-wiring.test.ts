// @vitest-environment jsdom
//
// **The undo toast, mounted in real React** — the second file in this suite
// to do that, and it exists for the same reason as the first.
//
// `tests/board-react-wiring.test.ts` was written after #128, where `request`
// was assigned inside a `setDrag` updater in `Board.tsx` and read on the line
// after it, so the very first drop sent nothing. `UndoToastHost.onUndo` was a
// verbatim recurrence of that defect: `planToRun` assigned inside a
// `setState` updater, read on the next line, and the early return firing
// while the state had already advanced to `undoing` — so the toast sat on
// "Undoing…" forever and **no request was ever sent**.
//
// ── Why no test in the pure layer could have caught it ──────────────────
//
// The PR that shipped this passed 34 of 34 hand-mutants. Every one of them
// tested a pure function, and the pure functions were all correct:
// `undoPressed` returns the right state, `inverseOf` derives the right plan,
// and `runUndo(inverseOf(action), fakeFetch)` issues exactly one correct
// POST — the reviewer proved that directly. The defect was in the
// *composition*, in the thirty lines that call them in order. As the review
// put it: the suite is green **and** both undo defects shipped — the units
// are tested, the composition is not.
//
// So this file asserts the one thing no unit test can: that pressing the
// button causes a request to reach the network, when the component is driven
// by real React with real scheduling.
//
// ── StrictMode is the specific behaviour being pinned ───────────────────
//
// Two independent mechanisms make an outer variable assigned inside an
// updater unreliable, and either alone reproduces the bug:
//
//   - **Deferral.** React 19 evaluates an updater eagerly only when
//     `0 === fiber.lanes && (null === alternate || 0 === alternate.lanes)`.
//     The toast runs a 250ms tick interval while counting down, so a lane is
//     routinely already pending and the updater defers past the read.
//   - **Double invocation.** StrictMode invokes updaters twice. On the second
//     pass `current.phase` is already `"undoing"`, so `undoPressed` returns it
//     unchanged, the identity comparison fails, and the variable is left
//     `null` — even though the first pass had set it.
//
// The tests below mount under `StrictMode` so the second mechanism is live,
// which is what the reviewer reproduced three times on clean loads. See the
// restore-the-defect note on the first test for the measured result.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** The repo
// is deliberately `environment: "node"` with no DOM library, and that is worth
// keeping: it is what stops component logic drifting back out of the testable
// seams it was extracted into. The docblock above scopes the DOM to this file
// alone. This is the exception, and it is narrow on purpose — it asserts
// *that the request is issued* and *that the toast renders at all*, not what
// the toast looks like. Rendering assertions belong in
// `tests/undo-toast-component.test.ts`, where they need no DOM.
import { createElement, StrictMode, useEffect } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UndoToastHost, useUndo } from "@/components/toast/UndoToastHost";
import type { UndoableAction } from "@/lib/undo";

/** Every transition POST that reached the stubbed network. */
const transitionCalls: { url: string; body: unknown }[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
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

/** An archive — permanently un-undoable, which is the MEDIUM's subject. */
function anArchive(at: number): UndoableAction {
  return { kind: "archive", at, itemId: "item-a", itemTitle: "A card" };
}

/**
 * Offers `action` through the real `useUndo()` context on mount, exactly as
 * a board drop or an archive would.
 *
 * Going through the context rather than reaching into the host's state is
 * the point: `offer` is the entire public surface of this feature, so a test
 * that bypassed it would not be testing the wiring anyone actually uses.
 */
function offerOnMount(action: UndoableAction) {
  return function Offerer() {
    const { offer } = useUndo();
    useEffect(() => {
      offer(action);
      // Offered once, on mount. Under StrictMode the effect runs twice, which
      // is faithful to what a real double-mount does and is harmless here:
      // `actionOffered` takes over the toast unconditionally, so the second
      // offer sets an identical value.
    }, [offer]);
    return null;
  };
}

/** Mounts the host with a child that offers `action`, under StrictMode. */
async function mountWith(action: UndoableAction): Promise<void> {
  const Offerer = offerOnMount(action);
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(StrictMode, null, createElement(UndoToastHost, null, createElement(Offerer))),
    );
  });
}

/**
 * The toast's Undo button, or null when none is rendered.
 *
 * Matched on `Undo` but not `Undone.` — the settled toast's message contains
 * the former as a prefix of the latter, and a helper that matched it would
 * find the *message* after an undo lands and report a button that is not
 * there. Buttons only, and the dismiss × is excluded by the text match.
 */
function undoButton(): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("Undo"),
    ) ?? null
  );
}

describe("UndoToastHost, mounted in real React under StrictMode", () => {
  it("renders the toast with an Undo button, so the assertions below are not vacuous", async () => {
    // Guards the guard. Every test below asserts on the effect of a click, so
    // if the toast stopped rendering they would all pass by never clicking
    // anything. This states the precondition directly and fails first.
    await mountWith(aMove(Date.now()));

    expect(container.querySelector('[data-phase="offered"]')).not.toBeNull();
    expect(undoButton()).not.toBeNull();
  });

  it("sends exactly one transition request when undo is pressed", async () => {
    // **The assertion this file exists for.**
    //
    // Restoring the defect — deriving `planToRun` inside the `setState`
    // updater and reading it on the next line — makes this **0 requests**,
    // measured. It is not a near miss: the early return fires on every press,
    // so the count is zero rather than two or one-of-the-wrong-shape.
    await mountWith(aMove(Date.now()));

    const button = undoButton();
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
    });

    expect(transitionCalls).toHaveLength(1);
    expect(transitionCalls[0]?.url).toContain("item-a/transition");
    // The inverse: back to where the move came from, with the state the move
    // landed on as the precondition. A plan derived from the wrong end of the
    // move would still be one request, so the body is asserted too.
    expect(transitionCalls[0]?.body).toEqual({ to: "on_deck", expectedFrom: "executing" });
  });

  it("leaves the toast reporting the outcome rather than stuck on Undoing…", async () => {
    // The other half of the defect's signature, and worth asserting
    // separately: the visible symptom was a toast frozen on "Undoing…" with
    // no way out but the dismiss ×. A change that issued the request but
    // never settled the toast would pass the test above and fail this one.
    await mountWith(aMove(Date.now()));

    await act(async () => {
      undoButton()?.click();
    });

    expect(container.querySelector('[data-phase="undone"]')).not.toBeNull();
    expect(container.textContent).toContain("Undone.");
    expect(container.textContent).not.toContain("Undoing…");
  });

  it("sends nothing more when undo is pressed twice", async () => {
    // The guard `undoPressed` provides at the pure layer, asserted through
    // the composition. The ref and the state advance together precisely so a
    // second press in the same tick reads `undoing` and is refused; if only
    // the state advanced, a press before the next render would send a second
    // set of transitions.
    await mountWith(aMove(Date.now()));

    const button = undoButton();
    await act(async () => {
      button?.click();
      button?.click();
    });

    expect(transitionCalls).toHaveLength(1);
  });

  it("shows an archive's confirmation with no Undo button, and does not collapse it", async () => {
    // The MEDIUM, asserted through the composition rather than on `ticked`
    // alone. `ticked` used to AND the window with `inverseOf(...).available`,
    // which is permanently false for an archive, so the first tick collapsed
    // the toast to idle and the confirmation was never seen at all.
    //
    // Widening `ticked`'s check to also require an available inverse fails
    // this: the toast is absent rather than present-without-a-button.
    await mountWith(anArchive(Date.now()));

    const toast = container.querySelector('[data-phase="offered"]');
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain("A card");
    // No button, because there is genuinely nothing to press — and the reason
    // is stated rather than the toast merely looking truncated — this is the
    // `unavailableReason` branch, and this test is what keeps it reachable.
    expect(undoButton()).toBeNull();
    expect(toast?.textContent).toContain("Archiving cannot be undone");
  });

  it("shows a no-op move's confirmation with no Undo button", async () => {
    // The same collapse hit a `from === to` move, which `inverseOf` refuses
    // for its own good reason (undoing it would write a second identical
    // state-change into the item's history). The confirmation should still
    // appear and say so.
    await mountWith({
      kind: "state-change",
      at: Date.now(),
      move: { itemId: "item-a", from: "executing", to: "executing" },
      itemTitle: "A card",
    });

    const toast = container.querySelector('[data-phase="offered"]');
    expect(toast).not.toBeNull();
    expect(undoButton()).toBeNull();
    expect(toast?.textContent).toContain("That did not change anything.");
    expect(transitionCalls).toHaveLength(0);
  });
});
