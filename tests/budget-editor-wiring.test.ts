// @vitest-environment jsdom
//
// **The budget editor, mounted in real React** — MILESTONES.md #87.
//
// The third file in this suite to do this, and it exists for the reason the
// first two do. `tests/board-react-wiring.test.ts` was written after #128
// (`request` assigned inside a `setDrag` updater and read on the next line,
// so the first drop sent nothing); `tests/undo-toast-host-wiring.test.ts`
// after the verbatim recurrence in `UndoToastHost.onUndo`. Both PRs shipped
// with green suites, because the pure functions being composed were all
// individually correct. As that review put it: **the units are tested, the
// composition is not.**
//
// This editor is exactly the shape those defects took — a read-modify-write
// whose save handler must consult a value (what was loaded) that no updater
// may compute for it. So this file asserts the things no unit test can:
//
//   1. Pressing Save actually issues a PUT, with the edited value.
//   2. The conflict check reads the *loaded* baseline at the moment Save
//      runs — so a stale render value would be caught.
//   3. When the stored value moved, **no PUT is issued at all**. This is
//      the acceptance criterion: a concurrent edit is not silently
//      clobbered. A test that only checked the message would pass even if
//      the write went out anyway.
//
// **StrictMode is deliberate.** It invokes updaters twice, which is one of
// the two mechanisms (the other being deferral) that make a value assigned
// inside an updater unreliable. Mounting without it would leave the pinned
// behaviour half-pinned.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** The
// repo is deliberately `environment: "node"` with no DOM, and that is worth
// keeping — it is what stops component logic drifting back out of the
// testable seams it was extracted into. This docblock scopes the DOM to
// this file alone, and the assertions here are about *wiring*, never about
// appearance: what the editor renders is asserted in
// `tests/budget-editor-component.test.ts`, which needs no DOM.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetEditor } from "@/components/budget/BudgetEditor";
import type { BudgetWindows } from "@/lib/settings/budget-windows";

/** Every write that reached the stubbed network. */
let puts: { url: string; body: unknown }[] = [];
/** What the next GET answers with — reassignable, so a save can race a change. */
let stored: BudgetWindows;
let getCount = 0;

let container: HTMLDivElement;
let root: Root;

function aWindow(stop = 90) {
  return {
    enabled: true,
    lengthHours: 24,
    boundaries: {
      selective: { kind: "constant", value: 50 },
      windDown: { kind: "constant", value: 75 },
      stop: { kind: "constant", value: stop },
    },
  } as const;
}

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  puts = [];
  getCount = 0;
  stored = { weekly: aWindow() };
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if ((init?.method ?? "GET") === "GET") {
        getCount += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ value: stored }),
        } as Response);
      }
      puts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as unknown });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ key: "budget.windows", value: stored }),
      } as Response);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Mounts the editor and lets its load settle. */
async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(StrictMode, null, createElement(BudgetEditor)));
  });
}

function findButton(text: string): HTMLButtonElement {
  const buttons = Array.from(container.querySelectorAll("button"));
  const found = buttons.find((button) => (button.textContent ?? "").includes(text));
  if (!found) {
    throw new Error(
      `No button containing "${text}". Buttons: ${buttons.map((b) => b.textContent).join(" | ")}`,
    );
  }
  return found;
}

function input(id: string): HTMLInputElement {
  // `getElementById` rather than a `#id` selector: this jsdom build has no
  // `CSS.escape`, and an id is matched literally here, so no escaping is
  // needed at all.
  const found = container.ownerDocument.getElementById(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`No input #${id}`);
  return found;
}

/**
 * The text of the collision panels only.
 *
 * Deliberately NOT `container.textContent`: the page's own subheading
 * explains that "a window that collides cannot be saved", so a whole-page
 * substring check for "collide" matches static copy and would pass with the
 * panel absent entirely. Scoping to the panel is what makes its absence
 * assertable.
 */
function collisionText(): string {
  return Array.from(container.querySelectorAll("[data-collision]"))
    .map((node) => node.textContent ?? "")
    .join(" ");
}

/** Types into a controlled input the way React sees a real keystroke. */
async function type(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the budget editor, mounted in real React", () => {
  it("loads the stored windows into fields", async () => {
    await mount();
    expect(input("budget-weekly-length").value).toBe("24");
    expect(input("budget-weekly-stop-value").value).toBe("90");
  });

  it("issues a PUT carrying the edited value when Save is pressed", async () => {
    // The defect this pins: in both prior occurrences the button worked, the
    // pure functions were right, and **no request was ever sent**. Only a
    // mounted component can prove one is.
    await mount();
    await type(input("budget-weekly-stop-value"), "95");

    await act(async () => {
      findButton("Save all windows").click();
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]?.body).toEqual({ value: { weekly: aWindow(95) } });
  });

  it("re-reads before writing, so a concurrent change can be seen at all", async () => {
    await mount();
    const afterLoad = getCount;
    await act(async () => {
      findButton("Save all windows").click();
    });
    // One extra GET, immediately before the PUT — the check-then-act.
    expect(getCount).toBe(afterLoad + 1);
  });

  it("REFUSES the write when the stored value moved underneath it", async () => {
    // The acceptance criterion, asserted as an absence: it is not enough to
    // show a message, the PUT must not go out. Checking only the message
    // would pass even if the clobber happened anyway.
    await mount();
    await type(input("budget-weekly-stop-value"), "95");

    // Somebody else saves while this form is open.
    stored = { weekly: aWindow(85), nightly: aWindow() };

    await act(async () => {
      findButton("Save all windows").click();
    });

    expect(puts).toHaveLength(0);
    expect(container.textContent).toContain("somebody else changed this first");
    // And it names what moved, which is what the reader's decision turns on.
    expect(container.textContent).toContain("nightly");
  });

  it("compares against what was LOADED, not against the newest render", async () => {
    // The stale-render defect, from the other direction: if the baseline
    // were read at render time rather than from a ref at save time, editing
    // a field after load could make the comparison see its own edit and
    // wrongly conclude somebody else had written.
    await mount();
    await type(input("budget-weekly-stop-value"), "95");
    await type(input("budget-weekly-length"), "48");

    await act(async () => {
      findButton("Save all windows").click();
    });

    // Our own edits are not a conflict — the write goes out.
    expect(puts).toHaveLength(1);
    expect(container.textContent).not.toContain("somebody else changed this first");
  });

  it("lets the reader take the other session's version after a conflict", async () => {
    await mount();
    await type(input("budget-weekly-stop-value"), "95");
    stored = { weekly: aWindow(85) };

    await act(async () => {
      findButton("Save all windows").click();
    });
    expect(puts).toHaveLength(0);

    await act(async () => {
      findButton("Discard my changes and load theirs").click();
    });

    // Their value is now in the field, and the conflict is cleared.
    expect(input("budget-weekly-stop-value").value).toBe("85");
    expect(container.textContent).not.toContain("somebody else changed this first");

    // And a save now succeeds, because the baseline moved with it.
    await act(async () => {
      findButton("Save all windows").click();
    });
    expect(puts).toHaveLength(1);
  });

  it("does not issue a write while the boundaries collide", async () => {
    // Save is disabled on a collision, and a disabled button that still
    // fired would be the worst of both worlds.
    await mount();
    // Push stop below windDown (75) — a real crossing.
    await type(input("budget-weekly-stop-value"), "10");

    expect(collisionText()).toContain("Wind down");
    expect(findButton("Save all windows").disabled).toBe(true);

    await act(async () => {
      findButton("Save all windows").click();
    });
    expect(puts).toHaveLength(0);
  });

  it("draws the collision in the form's own labels as it is typed", async () => {
    // Live, off the draft — not after a save round trip.
    await mount();
    await type(input("budget-weekly-stop-value"), "10");

    const text = collisionText();
    expect(text).toContain("Wind down");
    expect(text).toContain("Stop");
    // The schema's key spelling must not leak into the page.
    expect(text).not.toContain("windDown");

    // And the offending fieldsets are marked, so the reader is sent to the
    // boundary to change rather than left to work out which of three.
    const marked = Array.from(container.querySelectorAll("[aria-invalid='true']")).map((node) =>
      node.getAttribute("data-band"),
    );
    expect(marked.sort()).toEqual(["stop", "windDown"]);
  });

  it("clears the collision when the value is corrected", async () => {
    await mount();
    await type(input("budget-weekly-stop-value"), "10");
    expect(collisionText()).not.toBe("");

    await type(input("budget-weekly-stop-value"), "95");
    // The panel is gone entirely, not merely reworded.
    expect(collisionText()).toBe("");
    expect(findButton("Save all windows").disabled).toBe(false);
  });

  it("refuses to add a window whose name is already taken, without losing the draft", async () => {
    await mount();
    await type(input("budget-new-window"), "weekly");
    await act(async () => {
      findButton("Add window").click();
    });

    expect(container.textContent).toContain("already a window called");
    // The name stays in the box so it can be corrected rather than retyped.
    expect(input("budget-new-window").value).toBe("weekly");
    expect(puts).toHaveLength(0);
  });

  it("adds a window seeded with a preset that does not collide", async () => {
    await mount();
    await type(input("budget-new-window"), "nightly");
    await act(async () => {
      findButton("Add window").click();
    });

    expect(collisionText()).toBe("");
    expect(findButton("Save all windows").disabled).toBe(false);

    await act(async () => {
      findButton("Save all windows").click();
    });
    const body = puts[0]?.body as { value: Record<string, unknown> };
    expect(Object.keys(body.value).sort()).toEqual(["nightly", "weekly"]);
  });
});
