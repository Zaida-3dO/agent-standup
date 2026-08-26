// @vitest-environment jsdom
//
// **`ProjectDetailContainer`, mounted in real React.**
//
// `tests/project-detail-state.test.ts` proves `reparentItem(id, parentId)`
// serialises whatever `parentId` it is handed. `tests/project-detail-view.test.ts`
// and `tests/project-detail-component.test.ts` prove `RepairPanel` calls
// `onReparent` when its button is pressed. Neither can see the one line that
// sits between them — `ProjectDetailContainer.tsx`'s `onReparent` handler:
//
//   reparentItem(projectId, repairParentId.trim() === "" ? null : repairParentId.trim())
//
// This is structurally identical to the needs-you defect this row exists to
// catch: a ternary between two values, decided by the caller, invisible to a
// unit test of `reparentItem` (which is handed whatever the test passes it
// directly) and invisible to a unit test of `RepairPanel` (which never reads
// `parentId`, only calls `onParentIdChange`/`onReparent`). Only a test that
// types into the real rendered input and presses the real rendered button
// can see whether the field's current text reaches the request — or whether
// a caller sends a literal, drops the trim, or inverts the empty-string
// check.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** Same
// reasoning as `tests/board-react-wiring.test.ts`: the repo is deliberately
// `environment: "node"` with no DOM, which is what keeps component logic in
// the testable seams it was extracted into. This file is the narrow,
// deliberate exception — it asserts that the typed value reaches the
// network request, not what the panel looks like.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDetailContainer } from "@/components/project-detail/ProjectDetailContainer";
import { ITEM_STATES } from "@/lib/design/tokens";
import type { ProjectDetail, StateCounts } from "@/lib/project-detail/types";

/** Every state at zero, matching `tests/project-detail-view.test.ts`'s fixture helper. */
function noCounts(): StateCounts {
  return Object.fromEntries(ITEM_STATES.map((state) => [state, 0])) as StateCounts;
}

/** A childless project, so the repair panel renders — see `repairOfferFor`. */
function projectDetailFixture(): ProjectDetail {
  return {
    project: {
      id: "proj-1",
      title: "A stuck project",
      headline: null,
      area: "web",
      repo: null,
      priority: "P2",
      kind: "project",
    },
    derived: { column: "backlog", counts: noCounts(), causingChild: null },
    total: 0,
    merged: 0,
    finished: 0,
    progress: null,
    childless: true,
    lastActivity: "2026-08-18T10:00:00.000Z",
    children: [],
    blockedChildren: [],
    assignments: [],
    activity: [],
    repair: { childless: true, historicalVerificationAvailable: false },
  };
}

/** Every `POST .../reparent` the stubbed network received. */
const reparentCalls: { url: string; body: unknown }[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  reparentCalls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/reparent")) {
        reparentCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        } as Response);
      }
      if (url.includes("/api/ui/projects/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ detail: projectDetailFixture() }),
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
async function mountContainer(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(ProjectDetailContainer, { projectId: "proj-1" }),
      ),
    );
  });
}

function parentIdInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[data-repair-input="parentId"]');
  if (!input)
    throw new Error("no parentId repair input rendered — the fixture is wrong, not the code");
  return input;
}

function reparentButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[data-repair-action="reparent"]',
  );
  if (!button) throw new Error("no reparent button rendered — the fixture is wrong, not the code");
  return button;
}

/**
 * Types into a controlled input the way React sees a real keystroke —
 * matching `tests/budget-editor-wiring.test.ts`'s `type` helper.
 *
 * A plain `element.value = ...` followed by an `input` event does NOT work
 * here: React 19 tracks the input's value through the native setter it
 * patched onto the DOM node, and setting `.value` directly (which now hits
 * React's own instrumented setter) makes React believe the value "changed"
 * to what it already thinks it is, so the change handler never fires and
 * `repairParentId` never updates. Going through `HTMLInputElement.prototype`'s
 * setter bypasses that tracker, exactly as a real keystroke would.
 */
async function type(element: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ProjectDetailContainer, mounted in real React", () => {
  it("renders the repair panel, so the assertions below are not vacuous", async () => {
    await mountContainer();
    expect(container.querySelector('[data-repair-panel="true"]')).not.toBeNull();
    expect(parentIdInput()).not.toBeNull();
    expect(reparentButton()).not.toBeNull();
  });

  it("sends the typed parent id, trimmed, when reparent is pressed", async () => {
    // **The assertion this file exists for.** With the defect this row is
    // named after restored — e.g. `onReparent` sending a literal, or
    // omitting `.trim()`, or inverting the empty-string check — this either
    // sends the wrong value or sends it in the wrong branch, while every
    // unit test of `reparentItem` and every unit test of `RepairPanel` stays
    // green, because neither can see what the container actually decided to
    // pass.
    await mountContainer();

    await type(parentIdInput(), "  proj-9  ");
    await act(async () => {
      reparentButton().click();
    });

    expect(reparentCalls).toHaveLength(1);
    expect(reparentCalls[0]?.url).toContain("/api/ui/items/proj-1/reparent");
    expect(reparentCalls[0]?.body).toEqual({ parentId: "proj-9" });
  });

  it("sends null — top level — when the field is left empty", async () => {
    // The other arm of the ternary. A caller that always sent the raw
    // string would send `""` here instead of `null`, which the operation's
    // schema rejects outright (see `state.ts`'s comment on this exact
    // line) — so this is the case that would surface a dropped or inverted
    // empty-string check as a real refusal, not just a wrong-but-truthy
    // value.
    await mountContainer();

    await act(async () => {
      reparentButton().click();
    });

    expect(reparentCalls).toHaveLength(1);
    expect(reparentCalls[0]?.body).toEqual({ parentId: null });
  });

  it("does not send the empty string for a field that is only whitespace", async () => {
    // Distinguishes ".trim() === \"\"" from a bare "=== \"\"" check: a
    // caller comparing the untrimmed value against "" would treat
    // whitespace-only input as non-empty and forward it verbatim.
    await mountContainer();

    await type(parentIdInput(), "   ");
    await act(async () => {
      reparentButton().click();
    });

    expect(reparentCalls).toHaveLength(1);
    expect(reparentCalls[0]?.body).toEqual({ parentId: null });
    expect(reparentCalls[0]?.body).not.toEqual({ parentId: "   " });
  });
});
