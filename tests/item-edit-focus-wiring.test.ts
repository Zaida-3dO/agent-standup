// @vitest-environment jsdom
//
// **Where keyboard focus goes when an in-place editor opens and closes** —
// the clause in docs/DESIGN-LANGUAGE.md §6 that says "`Enter` saves,
// `Escape` cancels, and focus returns to the trigger on exit".
//
// This file exists because the doc asserted that and the app did not do it.
// Measured on the deployed board (v0.31.0 @ d67ad82), activating an editor
// by keyboard left `document.activeElement` on `BODY`, and so did pressing
// Escape afterwards. The consequence is worse than a misplaced focus ring:
// a control that does not hold focus never receives the keys aimed at it,
// so the editor's own Escape handler never ran and the editor could not be
// closed at all. The trigger was unmounted, the input was unfocused, and a
// keyboard-only reader's only ways out were a mouse or a page reload.
//
// **Why these assertions are about `document.activeElement` and nothing
// else.** `tests/item-edit-react-wiring.test.ts` already proves the editor
// OPENS and that the right PATCH goes out; every one of its assertions
// passed throughout the period the trap existed. Opening is not the
// property that was broken. So each test below asserts on where focus
// actually sits, which is the only thing that distinguishes the fixed
// behaviour from the broken one.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** Same
// reasoning as every other `*-wiring.test.ts` file in this suite.
//
// **What this does and does not prove.** jsdom implements `.focus()` and
// `document.activeElement` faithfully enough to pin the wiring — that the
// code calls focus on the right node at the right moment. It is not a real
// browser, so it does not prove the rendered page behaves this way for a
// real user; that was checked separately, by hand, through the browser
// broker. These tests are the regression guard, not the end-to-end proof.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemDetailContainer } from "@/components/item-detail/ItemDetailContainer";
import { ProfileContext } from "@/lib/profile/ProfileProvider";

let itemFixture: Record<string, unknown>;
let container: HTMLDivElement;
let root: Root;

function anItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-a",
    parentId: null,
    title: "The original title",
    headline: "The original headline",
    body: "",
    kind: "task",
    state: "on_deck",
    priority: "P2",
    area: "web",
    repo: null,
    branch: null,
    blockedReason: null,
    blockedOnType: null,
    blockedOnPersonId: null,
    unblockAt: null,
    pauseReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    originType: "person",
    archivedAt: null,
    archivedReason: null,
    supersededById: null,
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  itemFixture = anItem();
  container = document.createElement("div");
  // **Appended to the real document, not left detached.** `.focus()` is a
  // no-op on a node that is not in the document, so a detached container
  // would leave `activeElement` on BODY throughout — every assertion here
  // would report the exact bug this file is guarding against, whether or
  // not it was present.
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.includes("/detail")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              detail: {
                item: itemFixture,
                column: "backlog",
                subtasks: [],
                artifacts: [],
                history: [],
                historyTruncated: false,
                summary: null,
                assignments: [],
                previousHolders: [],
              },
            }),
        } as Response);
      }

      if (method === "PATCH" && url.includes("/api/ui/items/item-a")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              item: {
                id: "item-a",
                title: "whatever",
                state: "on_deck",
                headline: null,
                updatedAt: "x",
              },
            }),
        } as Response);
      }

      throw new Error(`unexpected fetch to ${method} ${url}`);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          ProfileContext.Provider,
          {
            value: {
              activeProfile: null,
              people: [],
              loadState: { status: "loaded", people: [] },
              setActiveProfile: () => {},
              pickerOpen: false,
              openPicker: () => {},
              closePicker: () => {},
            } as never,
          },
          createElement(ItemDetailContainer, { itemId: "item-a" }),
        ),
      ),
    );
  });
}

/** The trigger for a field, found by the accessible-name prefix a reader's screen reader would announce. */
function trigger(field: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label^="${field}:"]`);
  if (!button) throw new Error(`no ${field} trigger rendered — the fixture is wrong, not the code`);
  return button;
}

/** The control inside an open editor — an `<input>` for the three text fields, a `<select>` for priority. */
function editor(label: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    `input[aria-label="${label}"], select[aria-label="${label}"]`,
  );
  if (!el) throw new Error(`no ${label} editor rendered — press the trigger first`);
  return el;
}

/** Presses a key on whatever holds focus, the way a keyboard user does — never on a node the test picked. */
async function pressOnFocused(key: string): Promise<void> {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

/**
 * Activates a field's trigger.
 *
 * Returns nothing deliberately. The trigger is UNMOUNTED for the duration
 * of the edit and a fresh element is mounted in its place when it closes,
 * so a node captured here is detached by the time the assertion runs — the
 * very property that made the focus return hard to implement. Assertions
 * below therefore re-query with `trigger(field)`, which finds whichever
 * element is on the page now.
 */
async function activate(field: string): Promise<void> {
  await act(async () => {
    trigger(field).click();
  });
}

// All four editable fields (`EditableField`), so the fix is pinned for each
// rather than for the one that happened to be measured. Title and Headline
// render in `ItemDetailView`, Priority and Area in `StatusBlock`, and the
// three triggers that are NOT `InlineEditField`'s own are each wired
// separately — a fix applied to one file would leave the others trapped,
// and nothing but a per-field assertion would notice.
const FIELDS = [
  { field: "Title", label: "Title", tag: "INPUT" },
  { field: "Headline", label: "Headline", tag: "INPUT" },
  { field: "Priority", label: "Priority", tag: "SELECT" },
  { field: "Area", label: "Area", tag: "INPUT" },
] as const;

describe("focus movement through the in-place editors (DESIGN-LANGUAGE.md §6)", () => {
  describe.each(FIELDS)("$field", ({ field, label, tag }) => {
    it("moves focus into the editor when the trigger is activated", async () => {
      await mount();
      await activate(field);

      const control = editor(label);
      expect(control.tagName).toBe(tag);
      // The assertion that fails on the unfixed code: focus sat on BODY.
      expect(document.activeElement).toBe(control);
    });

    it("returns focus to the trigger when Escape cancels", async () => {
      await mount();
      await activate(field);

      // Pressed on whatever holds focus, not on a node this test picked.
      // That is the whole point: on the unfixed code focus was on BODY, so
      // this keydown went to BODY, the editor never saw it, and the editor
      // stayed open. Dispatching the key straight at the input instead
      // would paper over exactly the failure being guarded — the editor
      // would cancel in the test and stay stuck for a real user.
      await pressOnFocused("Escape");

      expect(editorIsOpen(label), "Escape did not close the editor").toBe(false);
      expect(document.activeElement).toBe(trigger(field));
    });

    it("returns focus to the trigger when Enter saves", async () => {
      await mount();
      await activate(field);

      await pressOnFocused("Enter");

      expect(editorIsOpen(label), "Enter did not close the editor").toBe(false);
      // A saved edit exits too, and a reader who pressed Enter is as lost
      // as one who pressed Escape if focus is dropped on the floor.
      expect(document.activeElement).toBe(trigger(field));
    });

    it("returns focus to the trigger when the Discard edit button cancels", async () => {
      // The mouse path through the same exit. Focus is already on a real
      // control here (the button that was clicked), so unlike the two
      // above this one never depended on the editor holding focus — it is
      // here so that a fix wired only to the key handlers is still caught.
      await mount();
      await activate(field);

      const discard = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent === "Discard edit",
      );
      if (!discard) throw new Error("no Discard edit button rendered");
      await act(async () => {
        discard.click();
      });

      expect(document.activeElement).toBe(trigger(field));
    });
  });

  it("does not steal focus back to the trigger on a later re-render", async () => {
    // The return signal has to be cleared once it has been acted on. Left
    // set, every subsequent re-render of the page re-runs the effect and
    // drags focus back to the trigger from wherever the reader has since
    // moved it — a slower, stranger version of the trap this fixes.
    await mount();
    await activate("Title");
    await pressOnFocused("Escape");
    expect(document.activeElement).toBe(trigger("Title"));

    // The reader Tabs away, then something re-renders the page.
    const elsewhere = trigger("Area");
    await act(async () => {
      elsewhere.focus();
    });
    await act(async () => {
      // A state change with nothing to do with editing — opening another
      // field's editor and leaving it open re-renders the whole detail.
      trigger("Headline").click();
    });

    expect(document.activeElement).not.toBe(trigger("Title"));
  });

  it("returns focus to the trigger that opened the edit, not to a different field's", async () => {
    // Four triggers share one edit slot. A signal that said only "an edit
    // ended" would be ambiguous between them, and the first trigger to
    // render would win every time — which reads as correct whenever the
    // test happens to exercise that field.
    await mount();
    await activate("Area");
    await pressOnFocused("Escape");

    expect(document.activeElement).toBe(trigger("Area"));
    expect(document.activeElement).not.toBe(trigger("Title"));
  });
});

/** Whether the named editor is still on the page — how "Escape cancelled" is distinguished from "Escape did nothing". */
function editorIsOpen(label: string): boolean {
  return (
    container.querySelector(`input[aria-label="${label}"], select[aria-label="${label}"]`) !== null
  );
}
