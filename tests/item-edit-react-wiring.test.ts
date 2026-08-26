// @vitest-environment jsdom
//
// **Inline field edit, mounted in real React** — the same shape as
// `tests/item-archive-react-wiring.test.ts` and `tests/item-cancel-react-wiring.test.ts`,
// applied to `ItemDetailContainer`'s `onSaveEdit`.
//
// `tests/item-detail-edit-state.test.ts` proves `fieldForEdit(field, draft)`
// maps a field name and a draft string to the right PATCH body — including
// that an empty headline draft becomes `null`, not `""`. `tests/item-detail-view.test.ts`
// and `tests/inline-edit-field-component.test.ts` prove `InlineEditField`
// calls `onSave` when its Save button is pressed. **Neither can see
// `ItemDetailContainer.tsx`'s `onSaveEdit`** — the seam this row is about:
//
//   submitItemEdit(itemId, fieldForEdit(editingField, draft))
//
// `editingField` and `draft` both come from container state set by
// `onStartEdit`/`onDraftChange`. A caller that sent a literal field name, or
// read the wrong field's draft, or dropped the trim-to-null on an emptied
// headline, would satisfy every unit test above (each is handed its inputs
// directly) while sending the wrong PATCH body — the same needs-you shape
// as the rest of this suite.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** Same
// reasoning as every other `*-wiring.test.ts` file in this suite.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemDetailContainer } from "@/components/item-detail/ItemDetailContainer";
import { ProfileContext } from "@/lib/profile/ProfileProvider";

/** Every PATCH the stubbed network received. */
const patches: { url: string; body: unknown }[] = [];

/** The item the detail read returns. Reset per test, matching `tests/item-archive-react-wiring.test.ts`'s fixture. */
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
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  patches.length = 0;
  itemFixture = anItem();
  container = document.createElement("div");
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
        const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
        patches.push({ url, body });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              item: { id: "item-a", title: "whatever", state: "on_deck", headline: null, updatedAt: "x" },
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

/** Mounts the real container under StrictMode — matches `tests/item-archive-react-wiring.test.ts`. */
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

function editTitleButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Edit title"]');
  if (!button) throw new Error("no Edit title button rendered — the fixture is wrong, not the code");
  return button;
}

function editHeadlineButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Edit headline"]');
  if (!button) throw new Error("no Edit headline button rendered");
  return button;
}

function draftInput(label: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`no ${label} draft input rendered — press Edit first`);
  return input;
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "Save",
  );
  if (!button) throw new Error("no Save button rendered — press Edit first");
  return button;
}

/** Types into a controlled input the way React sees a real keystroke — matches `tests/budget-editor-wiring.test.ts`. */
async function type(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the item detail page's inline edit, mounted in real React", () => {
  it("renders the title's edit control once Edit is pressed, so the assertions below are not vacuous", async () => {
    await mount();
    await act(async () => {
      editTitleButton().click();
    });
    expect(draftInput("Title")).not.toBeNull();
    expect(saveButton()).not.toBeNull();
  });

  it("saves the typed title under the title key, not a literal or the wrong field", async () => {
    // **The core assertion.** With `onSaveEdit` reading the wrong seam —
    // hard-coding a field, or reading the wrong draft — this sends either
    // nothing under `title`, or the original stored value, or a body keyed
    // wrong. No unit test of `fieldForEdit` or `submitItemEdit` can see
    // this: each is handed its inputs directly by its own test.
    await mount();
    await act(async () => {
      editTitleButton().click();
    });
    await type(draftInput("Title"), "A corrected title");
    await act(async () => {
      saveButton().click();
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toContain("/api/ui/items/item-a");
    expect(patches[0]?.body).toEqual({ title: "A corrected title" });
  });

  it("saves an emptied headline as null, not an empty string", async () => {
    // **The seam's sharpest edge.** `fieldForEdit` trims and converts an
    // empty headline draft to `null` — a caller that forwarded the raw
    // draft string unconditionally would send `headline: ""`, which is a
    // materially different instruction to the server (a headline explicitly
    // set to an empty string, rather than cleared).
    await mount();
    await act(async () => {
      editHeadlineButton().click();
    });
    await type(draftInput("Headline"), "   ");
    await act(async () => {
      saveButton().click();
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ headline: null });
  });
});
