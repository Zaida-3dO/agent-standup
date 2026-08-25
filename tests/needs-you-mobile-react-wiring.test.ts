// @vitest-environment jsdom
//
// **The Needs-you inbox mounted in real React**, for the composition that
// the mobile flow is actually about: a decision taken with a thumb.
//
// ── Why a mounted test and not a unit test ──────────────────────────────
//
// This is the fourth file in this suite to mount a real component, and it
// exists for the reason the first three do. `tests/board-react-wiring.test.ts`
// was written after a value assigned inside a `setDrag` updater was read on
// the line after it; `tests/undo-toast-host-wiring.test.ts` after the same
// defect recurred in `UndoToastHost.onUndo`;
// `tests/item-archive-react-wiring.test.ts` after it shipped a third time.
// Every time, each pure function being composed was correct on its own and
// every unit test stayed green. The defect was in the thirty lines that call
// them in order.
//
// `NeedsYouRow` is a pure function of its props and is easy to test as one.
// What no such test can reach is whether pressing Approve on a phone-sized
// row actually posts a decision for **that** row — the `deciding` flag is
// per-item, the handlers are built in a container, and the id travels from
// a click through a `useState` before any request is made. That is the exact
// shape that has now shipped three times.
//
// Mounted under `StrictMode` so updaters are double-invoked and React's
// deferral paths are live, matching the three files above. Deferral is the
// trigger for the recurring defect, not StrictMode's double invocation
// specifically, so both are exercised rather than either being relied on.
//
// ── What this does NOT claim ───────────────────────────────────────────
//
// **It does not measure a rendered layout.** jsdom has no layout engine, so
// nothing here observes a 44px button or a 390px viewport, and no assertion
// below pretends to. The widths and tap-target sizes for this change were
// measured in a real browser and are recorded in the pull request.
// `tests/board-list-view-density.test.ts` documents what happens when a test
// computes a width from a stylesheet and calls that a rendered measurement:
// the first fix for that defect shipped broken while its test passed.
//
// What this file pins is the half a browser measurement cannot: that the
// composition still works, so the row a thumb lands on is the row that gets
// decided.
//
// ── What would break these tests (they are not hollow) ─────────────────
//
//   - Having `onApprove` close over a stale id — the recurring defect —
//     fails "approves the row that was pressed, not the first row".
//   - Dropping `deciding` from the row props, or making it global rather
//     than per-item, fails "disables only the row being decided".
//   - Posting to `/deny` from the approve handler fails the same test.
//   - Not clearing `deciding` after a failed decision fails "re-enables the
//     row after a refusal", which is what would otherwise strand a phone
//     user on a dead row with no way to retry.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NeedsYouInbox } from "@/components/needs-you/NeedsYouInbox";
import { ProfileContext } from "@/lib/profile/ProfileProvider";

/** Every non-GET request that reached the stubbed network, in order. */
const writes: { method: string; url: string; body: unknown }[] = [];

/** What the next decision responds with. Replaced per test. */
let decideResponse: { ok: boolean; status: number; body: unknown };

let container: HTMLDivElement;
let root: Root;

const ITEMS = [
  {
    id: "first-row",
    title: "The first row, which is not the one that gets pressed",
    state: "in_review",
    headline: null,
    reason: "needs_approval",
    mergeAuthority: "needs_approval",
    updatedAt: "2026-08-25T09:00:00.000Z",
    blockedReason: null,
  },
  {
    id: "second-row",
    title: "The second row, which is the one a thumb lands on",
    state: "in_review",
    headline: null,
    reason: "needs_approval",
    mergeAuthority: "needs_approval",
    updatedAt: "2026-08-25T09:00:00.000Z",
    blockedReason: null,
  },
];

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  writes.length = 0;
  decideResponse = { ok: true, status: 200, body: { ok: true } };
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.includes("/needs-you")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ items: ITEMS, total: ITEMS.length }),
        } as Response);
      }

      if (method !== "GET") {
        let parsed: unknown = null;
        if (typeof init?.body === "string") {
          try {
            parsed = JSON.parse(init.body);
          } catch {
            parsed = init.body;
          }
        }
        writes.push({ method, url, body: parsed });
        return Promise.resolve({
          ok: decideResponse.ok,
          status: decideResponse.status,
          json: () => Promise.resolve(decideResponse.body),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as Response);
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Mounts the inbox with a chosen profile, as the page does. */
async function mountInbox(): Promise<void> {
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
              loadState: {
                status: "loaded",
                people: [{ id: "ope", displayName: "Ope", avatar: null, colour: null }],
              },
              activeProfile: { id: "ope", displayName: "Ope", avatar: null, colour: null },
              setActiveProfile: () => {},
              pickerOpen: false,
              setPickerOpen: () => {},
              addProfile: () => {},
            } as never,
          },
          createElement(NeedsYouInbox),
        ),
      ),
    );
  });
}

/** Every rendered button whose label matches, in document order. */
function buttonsLabelled(label: string): HTMLButtonElement[] {
  // `Array.from` rather than a spread: this project's `tsc` target does not
  // enable `downlevelIteration`, so spreading a `NodeListOf` is a type error
  // even though it runs. `Array.from` also carries the element type through,
  // which is what removes the need for a cast here.
  return Array.from(container.querySelectorAll("button")).filter(
    (b) => (b.textContent ?? "").trim() === label,
  );
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("deciding from the inbox", () => {
  it("renders a decision affordance per decidable row", async () => {
    await mountInbox();

    // Guards the guard: if the rows never rendered, every assertion below
    // would pass vacuously by finding zero buttons and clicking nothing.
    expect(buttonsLabelled("Approve")).toHaveLength(2);
    expect(buttonsLabelled("Deny")).toHaveLength(2);
  });

  it("approves the row that was pressed, not the first row", async () => {
    await mountInbox();

    // The second one, deliberately: a handler closing over a stale id — the
    // defect that has shipped three times — sends the first row's id here
    // and passes any test that only ever presses the first button.
    await click(buttonsLabelled("Approve")[1]!);

    // An approval records an artifact and then transitions, so more than one
    // write is expected — the point is WHICH row every one of them names.
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.url).toContain("second-row");
      expect(write.url).not.toContain("first-row");
    }
    expect(writes[0]!.body).toMatchObject({ verdict: "lgtm" });

    // The transition carries the row's OWN server-reported state as its
    // precondition (#257/#292). Asserted here rather than only in
    // `needs-you-decide.test.ts` because this is the seam that test cannot
    // see: `decide.ts` is handed an `expectedFrom` and can only be trusted to
    // forward it, while it is this component that decides where the value
    // comes from. A call site passing the target (`"merged"`), or a state
    // derived from `reason` rather than read from the row, still reaches the
    // right item with the right verdict and is invisible above.
    const transition = writes.find((write) => write.url.includes("/transition"));
    expect(transition).toBeDefined();
    expect(transition!.body).toMatchObject({ to: "merged", expectedFrom: "in_review" });
  });

  it("denies the row that was pressed, and does not approve it", async () => {
    await mountInbox();

    await click(buttonsLabelled("Deny")[1]!);

    expect(writes[0]!.url).toContain("second-row");
    // Approve and Deny post to the SAME endpoint and differ only in the
    // verdict they carry, so the id alone cannot tell them apart — a handler
    // wired to the wrong one is invisible to a test that checks only the id.
    expect(writes[0]!.body).toMatchObject({ verdict: "changes_required" });
    expect(writes[0]!.body).not.toMatchObject({ verdict: "lgtm" });
  });

  it("disables only the row being decided, so a thumb cannot fire twice", async () => {
    // A decision that never settles, so the in-flight state is observable.
    decideResponse = { ok: true, status: 200, body: { ok: true } };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String(input);
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("/needs-you")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ items: ITEMS, total: ITEMS.length }),
          } as Response);
        }
        writes.push({ method, url, body: null });
        return new Promise(() => {
          /* never settles — the decision stays in flight */
        });
      }),
    );

    await mountInbox();
    const approves = buttonsLabelled("Approve");
    await click(approves[1]!);

    const after = buttonsLabelled("Approve");
    // The pressed row is locked...
    expect(after[1]!.disabled).toBe(true);
    // ...and the other row is emphatically not: a global flag here would
    // freeze the whole inbox on one slow request, which on a phone reads as
    // the page having broken.
    expect(after[0]!.disabled).toBe(false);

    // Pressing the locked one again sends nothing further.
    const before = writes.length;
    await click(after[1]!);
    expect(writes).toHaveLength(before);
  });

  it("re-enables the row after a refusal, so the decision can be retried", async () => {
    decideResponse = {
      ok: false,
      status: 409,
      body: { error: { code: "conflict", message: "Someone else decided this first." } },
    };

    await mountInbox();
    await click(buttonsLabelled("Approve")[1]!);

    // Stranding a phone user on a permanently disabled row with no way to
    // retry is the failure this pins.
    expect(buttonsLabelled("Approve")[1]!.disabled).toBe(false);
  });
});
