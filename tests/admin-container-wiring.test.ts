// @vitest-environment jsdom
//
// **`Admin`, mounted in real React.**
//
// `tests/admin-values.test.ts` proves `fromInput` parses a raw string for a
// given field kind. `tests/admin-state.test.ts` proves `updateRow` PATCHes
// whatever body it is handed, and that `buildPatchBody` drops read-only
// keys. `tests/admin-view-component.test.ts` proves `AdminField` renders an
// inherit checkbox and calls `onInheritChange`/`onChange` when pressed or
// typed into. None of the three can see `Admin.tsx`'s `collect()` — the
// seam this row is about — which decides, PER FIELD, whether the row's
// override survives the save:
//
//   - if the field overrides a setting and is now inheriting: skip it
//     entirely UNLESS it was previously overridden, in which case send an
//     explicit `null` to actually clear the override (§17.7's "an omitted
//     field is no change");
//   - otherwise: read the draft, and if it was never touched, skip the
//     field rather than sending `undefined`.
//
// A caller that always sent `null` for an inheriting field (a spurious
// no-op PATCH every save, even when nothing changed), or that read the
// checkbox the wrong way round, or that dropped the "only if it changed"
// guard, would satisfy every unit test above while sending the wrong PATCH
// body — the same needs-you shape as the other two files in this suite.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** Same
// reasoning as the sibling `*-wiring.test.ts` files: the harness is
// deliberately `environment: "node"` with no DOM everywhere else, and this
// is the narrow exception that asserts the real PATCH body a real button
// press produces.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "@/components/admin/Admin";
import { adminKindBySlug } from "@/lib/admin/kinds";
import type { AdminRow } from "@/lib/admin/state";

const MACHINES = adminKindBySlug("machines");
if (!MACHINES) throw new Error("machines kind not registered — fixture assumption is wrong");

/** A machine row with an existing override, so the inherit-vs-override branch is exercised both ways. */
function machineRow(overrides: Partial<AdminRow> = {}): AdminRow {
  return {
    name: "calliope",
    lastPollAt: "2026-08-18T10:00:00.000Z",
    liveSessions: 2,
    sourceGlobs: ["src/**", "tests/**"],
    ...overrides,
  };
}

/** Every `PATCH .../machines/{id}` the stubbed network received. */
const patchCalls: { url: string; body: Record<string, unknown> }[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  patchCalls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/api/ui/machines/") && method === "PATCH") {
        patchCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        } as Response);
      }
      if (url.includes("/api/ui/machines")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ machines: [machineRow()] }),
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

/** Mounts the real container under StrictMode and lets the mount-time load resolve. */
async function mountAdmin(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(StrictMode, null, createElement(Admin, { kind: MACHINES! })));
  });
}

function editButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "Edit",
  );
  if (!button) throw new Error("no Edit button rendered — the fixture is wrong, not the code");
  return button;
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === "Save",
  );
  if (!button) throw new Error("no Save button rendered — press Edit first");
  return button;
}

function sourceGlobsTextarea(): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>("#admin-sourceGlobs");
  if (!textarea) throw new Error("no sourceGlobs textarea rendered — press Edit first");
  return textarea;
}

function inheritCheckbox(): HTMLInputElement {
  const checkbox = container.querySelector<HTMLInputElement>(
    '[aria-label="Inherit minting.source_globs"]',
  );
  if (!checkbox) throw new Error("no inherit checkbox rendered — press Edit first");
  return checkbox;
}

/** Types into a controlled textarea the way React sees a real keystroke — matches `tests/budget-editor-wiring.test.ts`'s pattern for inputs. */
async function type(element: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Admin, mounted in real React", () => {
  it("renders the row's editor once expanded, so the assertions below are not vacuous", async () => {
    await mountAdmin();
    await act(async () => {
      editButton().click();
    });
    expect(sourceGlobsTextarea()).not.toBeNull();
    expect(inheritCheckbox()).not.toBeNull();
    expect(saveButton()).not.toBeNull();
  });

  it("sends the edited override value, parsed into a list", async () => {
    // **The core assertion.** With `collect()` reading the wrong source —
    // a literal, or the stored value instead of the draft — this sends
    // either nothing or the row's unedited globs. No unit test of
    // `fromInput` or `updateRow` can see this: each is handed a value
    // directly by its own test.
    await mountAdmin();
    await act(async () => {
      editButton().click();
    });

    await type(sourceGlobsTextarea(), "only-this/**");
    await act(async () => {
      saveButton().click();
    });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]?.url).toContain("/api/ui/machines/calliope");
    expect(patchCalls[0]?.body).toEqual({ sourceGlobs: ["only-this/**"] });
  });

  it("sends an explicit null to clear an override when inherit is newly checked", async () => {
    // **The seam's sharpest edge.** `wasInheriting` is `false` here (the
    // fixture row carries an override), so checking "inherit" must send
    // `sourceGlobs: null` — not omit the field, which `buildPatchBody`
    // would otherwise treat as "no change" and leave the override in
    // place. A caller that always skipped an inheriting field regardless
    // of the row's prior state would pass every fixture where the row
    // already inherits and fail silently only on a row like this one.
    await mountAdmin();
    await act(async () => {
      editButton().click();
    });

    await act(async () => {
      // A real click on a checkbox toggles `.checked` AND fires the
      // `click`-then-`change` sequence React listens to for its `onChange` —
      // unlike a text input, a checkbox's synthetic change is not driven
      // through the patched `value` setter, so `.click()` is the faithful
      // simulation here.
      inheritCheckbox().click();
    });
    await act(async () => {
      saveButton().click();
    });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]?.body).toEqual({ sourceGlobs: null });
  });

  it("sends nothing for a field nobody touched", async () => {
    // The "only if it changed" half. A caller that sent every field
    // unconditionally would PATCH the row's own stored value back at it on
    // every save — technically a no-op server-side, but not what "only
    // fields the person actually touched are sent" (state.ts's own
    // contract) promises, and it would mask a real regression in the
    // touched-field case if this test only checked for absence of an
    // error.
    await mountAdmin();
    await act(async () => {
      editButton().click();
    });

    await act(async () => {
      saveButton().click();
    });

    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]?.body).toEqual({});
  });
});
