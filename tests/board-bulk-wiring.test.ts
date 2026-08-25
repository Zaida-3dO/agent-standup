// @vitest-environment jsdom
//
// **The composition layer for T6-E**, and the reason it exists is the same
// reason `tests/board-react-wiring.test.ts` exists — restated here because
// the lesson has now cost this repo four occurrences.
//
// `tests/board-selection.test.ts` and `tests/board-bulk.test.ts` cover the
// extracted seams thoroughly: 38 assertions, all passing, over pure
// functions that are individually correct. **None of them would notice the
// defect this file is written to catch.** That defect lives in the wiring
// into React: a value assigned inside a `setState` updater and read outside
// it. React 19 evaluates an updater eagerly only when no update is already
// pending on the fiber and defers it otherwise, and StrictMode invokes it
// twice — so a selection computed inside `setSelection((current) => …)` and
// then acted on is not reliably the selection that gets acted on.
//
// Selection is exactly that shape: every gesture is a function of the
// current selection, and the tempting way to read the current selection is
// from inside the updater. `scripts/check-updater-side-effects.mjs` catches
// the *syntactic* form of this — but its own header is explicit that a
// mutant with a `?? fallback`, or an updater hoisted to a named function,
// slips past it, and that only a composition test mounted under real React
// covers the inverse defect (a handler reading a stale render value instead
// of a ref).
//
// So this file mounts the real `ListViewContainer` under StrictMode in
// jsdom and drives whole gestures — tick, shift-tick, bulk, undo offer —
// asserting on **what reaches the network** and **what the undo is offered
// with**. Those are the two facts a stale selection would get wrong.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** The
// repo is deliberately `environment: "node"` with no DOM library, which is
// what stops component logic drifting back out of the testable seams it was
// extracted into. The docblock above scopes the DOM to this file alone.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListViewContainer } from "@/components/board/ListViewContainer";
import type { UndoableAction } from "@/lib/undo";

// The container reads the active profile from context. Selection is wired
// regardless of who is active, so a fixed stub keeps this file about
// scheduling rather than about profiles.
vi.mock("@/lib/profile/ProfileProvider", () => ({
  useProfile: () => ({ activeProfile: { id: "person-1", name: "Test" } }),
}));

// The container reads its filters out of the URL and navigates to change
// them, which needs the app router mounted — and mounting a real router
// here would drag Next's navigation runtime into a file that exists to test
// React's update scheduling. `useSearchParams` returns a real
// `URLSearchParams` because the container calls `.toString()` on it to key
// the load effect.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/board",
}));

/**
 * The undo offers this run produced.
 *
 * **`useUndo` is stubbed rather than the host being mounted.** The host's
 * own wiring has its own composition test
 * (`tests/undo-toast-host-wiring.test.ts`); what this file needs to know is
 * *what the container hands it*, which is the thing a stale selection would
 * get wrong. Capturing the argument is a sharper assertion than reading a
 * rendered toast, because it shows the per-item `from` values that
 * `inverseOf` will later depend on.
 */
const offers: UndoableAction[] = [];
vi.mock("@/components/toast", () => ({
  useUndo: () => ({
    offer: (action: UndoableAction) => {
      offers.push(action);
    },
  }),
}));

/** Every transition request the run issued, in order. */
const transitionCalls: { url: string; body: Record<string, unknown> }[] = [];
/** Item ids the stub should refuse, with the status and body to refuse with. */
let refusals: Record<string, { status: number; body: unknown }> = {};

/** Four rows in Backlog, each in a DIFFERENT state — the point of the fixture. */
function backlogRows() {
  return ["a", "b", "c", "d"].map((id, index) => ({
    item: {
      id,
      // A distinct state per row, so a bulk that sent one shared
      // `expectedFrom` for the batch is observably wrong rather than
      // accidentally right.
      state: ["on_deck", "planning", "executing", "someday"][index],
      title: `Item ${id}`,
      headline: null,
      kind: "task",
      priority: "P1",
      area: "web",
      repo: null,
      blockedOnPersonId: null,
      blockedOnType: null,
      blockedReason: null,
      pauseReason: null,
    },
    column: "backlog",
    assignments: [],
    trust: null,
    subtasks: null,
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  transitionCalls.length = 0;
  offers.length = 0;
  refusals = {};
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      // **The `/api/ui` prefix is matched, not assumed.** A T17 crew's stub
      // missed it and its composition test failed 6/10 while all 75 of its
      // pure tests were green — the fetches went unmatched and fell through
      // to the throw below.
      if (url.includes("/api/ui/board")) {
        const parsed = new URL(url, "http://localhost");
        const column = parsed.searchParams.get("column") ?? "backlog";
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              board: {
                columns: {
                  [column]:
                    column === "backlog"
                      ? { entries: backlogRows(), total: 4, nextCursor: null, withheld: false }
                      : { entries: [], total: 0, nextCursor: null, withheld: false },
                },
              },
            }),
        } as Response);
      }
      if (url.includes("/transition")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        transitionCalls.push({ url, body });
        const refusedId = Object.keys(refusals).find((id) => url.includes(`/items/${id}/`));
        if (refusedId) {
          const refusal = refusals[refusedId];
          return Promise.resolve({
            ok: false,
            status: refusal?.status ?? 409,
            json: () => Promise.resolve(refusal?.body ?? {}),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ item: {} }),
        } as Response);
      }
      // The filter options and saved views the bar fetches — answered
      // rather than thrown on, so an unrelated call does not fail the file.
      if (url.includes("/api/ui/")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ areas: [], repos: [], people: [], views: [] }),
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

/**
 * Mounts `ListViewContainer` **under StrictMode** and lets the mount-time
 * board load resolve.
 *
 * StrictMode is not decoration here. It is the mechanism that made the
 * third occurrence of this defect observable: it invokes updaters twice, so
 * the second pass sees a `current` the handler has already advanced and
 * takes the opposite branch. Without it, React invokes the updater eagerly
 * exactly once and an outer variable written inside one is set in time —
 * which is how a broken feature passes a green suite.
 */
async function mountList(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(StrictMode, null, createElement(ListViewContainer)));
  });
  // Let the four column reads settle.
  await act(async () => {
    await Promise.resolve();
  });
}

/** The checkbox for one row. */
function checkbox(id: string): HTMLInputElement {
  const node = container.querySelector<HTMLInputElement>(`[data-testid="list-select-${id}"]`);
  if (!node) throw new Error(`no checkbox for ${id}`);
  return node;
}

/** Clicks a row's checkbox, optionally with shift held. */
async function clickRow(id: string, shiftKey = false): Promise<void> {
  await act(async () => {
    checkbox(id).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey }));
  });
}

/** Presses one of the bar's action buttons. */
async function pressAction(to: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="bulk-${to}"]`);
  if (!button) throw new Error(`no bulk button for ${to}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // Let the sequential transitions and the settle-up run.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function barText(): string {
  return container.querySelector('[data-testid="bulk-action-bar"]')?.textContent ?? "";
}

describe("selection, mounted under StrictMode", () => {
  it("shows no bar until a row is ticked", async () => {
    await mountList();
    expect(container.querySelector('[data-testid="bulk-action-bar"]')).toBeNull();
    await clickRow("a");
    expect(container.querySelector('[data-testid="bulk-count"]')?.textContent).toBe("1 selected");
  });

  it("counts two independent ticks", async () => {
    // The plain path, and the one a deferred updater breaks first: if the
    // handler computed the next selection inside the updater, the second
    // click would read a pre-first-click selection and the count would
    // stick at 1.
    await mountList();
    await clickRow("a");
    await clickRow("c");
    expect(container.querySelector('[data-testid="bulk-count"]')?.textContent).toBe("2 selected");
  });

  it("unticks on a second click of the same row", async () => {
    await mountList();
    await clickRow("a");
    await clickRow("a");
    expect(container.querySelector('[data-testid="bulk-action-bar"]')).toBeNull();
  });

  it("selects a whole range on shift-click, across the anchor", async () => {
    // The gesture the row asks for by name. This needs the ANCHOR to have
    // survived the first click into the second handler — the exact value a
    // deferred updater would lose.
    await mountList();
    await clickRow("a");
    await clickRow("d", true);
    expect(container.querySelector('[data-testid="bulk-count"]')?.textContent).toBe("4 selected");
  });

  it("select-all ticks every row", async () => {
    await mountList();
    const all = container.querySelector<HTMLInputElement>('[data-testid="list-select-all"]');
    if (!all) throw new Error("no select-all box");
    await act(async () => {
      // **A plain click, exactly as a person makes it.** jsdom runs the
      // checkbox's own activation behaviour on a click — it flips `checked`
      // and fires the change event itself — so this drives `onChange`
      // through the real path rather than simulating its result.
      //
      // Worth recording, because two more-elaborate forms were tried first
      // and BOTH failed against a component that works: dispatching a bare
      // `change` (React's synthetic `onChange` is wired to `input`), and
      // setting `checked` through the prototype setter before dispatching
      // `input` (React's own value tracking then treats the state as
      // already reconciled). Simulating less is what made this correct.
      all.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="bulk-count"]')?.textContent).toBe("4 selected");
  });
});

describe("bulk actions, mounted under StrictMode", () => {
  it("sends one transition per selected row, each with its OWN expectedFrom", async () => {
    // **The assertion this whole file is for.** The four rows are in four
    // different states; a bulk that sent one shared `expectedFrom` — or
    // that read a stale selection and sent the wrong rows — fails here and
    // passes every pure test in the suite.
    await mountList();
    await clickRow("a");
    await clickRow("d", true);
    await pressAction("executing");

    expect(transitionCalls).toHaveLength(4);
    expect(
      transitionCalls.map((call) => [
        call.url.split("/items/")[1]?.split("/")[0],
        call.body.expectedFrom,
        call.body.to,
      ]),
    ).toEqual([
      ["a", "on_deck", "executing"],
      ["b", "planning", "executing"],
      ["c", "executing", "executing"],
      ["d", "someday", "executing"],
    ]);
  });

  it("offers ONE bulk undo carrying every move's own origin", async () => {
    // The undo is derived entirely from what the action recorded about
    // itself, so a bulk that recorded the wrong origins would undo items to
    // states they were never in — silently, ten seconds later.
    await mountList();
    await clickRow("a");
    await clickRow("b", true);
    await pressAction("merged");

    expect(offers).toHaveLength(1);
    const action = offers[0];
    if (action?.kind !== "bulk") throw new Error("expected a bulk offer");
    expect(action.to).toBe("merged");
    expect(action.moves).toEqual([
      { itemId: "a", from: "on_deck", to: "merged" },
      { itemId: "b", from: "planning", to: "merged" },
    ]);
  });

  it("applies the rest when one row is refused, and says so", async () => {
    // The partial decision, end to end. Three requests go out, two land,
    // and the bar reports two-of-three rather than success.
    refusals = {
      b: {
        status: 409,
        body: {
          error: {
            message: "stale",
            details: { itemId: "b", expectedFrom: "planning", currentState: "merged" },
          },
        },
      },
    };
    await mountList();
    await clickRow("a");
    await clickRow("c", true);
    await pressAction("executing");

    expect(transitionCalls).toHaveLength(3);
    expect(barText()).toContain("Moved 2 of 3");
    expect(barText()).toContain("refused");
    // The refused row is named, with where it actually is.
    expect(barText()).toContain("Item b");
    expect(barText()).toContain("now in merged");
  });

  it("offers an undo covering ONLY the rows that moved", async () => {
    // Offering the whole selection would promise to put back a row that was
    // never moved — `inverseOf` cannot filter that, because a refused row
    // has no from/to pair to filter on.
    refusals = { b: { status: 422, body: { error: { message: "A guard said no." } } } };
    await mountList();
    await clickRow("a");
    await clickRow("c", true);
    await pressAction("executing");

    const action = offers[0];
    if (action?.kind !== "bulk") throw new Error("expected a bulk offer");
    expect(action.moves.map((move) => move.itemId)).toEqual(["a", "c"]);
  });

  it("offers NO undo when every row was refused", async () => {
    // `inverseOf` returns an unavailable plan for a bulk that moved
    // nothing, and the toast would then show a button that cannot work.
    // Not offering is the honest form of the same fact — and it is the
    // behaviour `tests/undo-actions.test.ts`'s "unavailable when the bulk
    // moved nothing at all" case exists to protect.
    refusals = {
      a: { status: 422, body: { error: { message: "no" } } },
      b: { status: 422, body: { error: { message: "no" } } },
    };
    await mountList();
    await clickRow("a");
    await clickRow("b", true);
    await pressAction("executing");

    expect(offers).toHaveLength(0);
    expect(barText()).toContain("None of the 2 items");
  });

  it("keeps the refused rows ticked and clears the ones that moved", async () => {
    // The refused rows are exactly the ones the reader may want to retry,
    // and they are named in a report they would otherwise have to re-find
    // by hand.
    refusals = { b: { status: 422, body: { error: { message: "no" } } } };
    await mountList();
    await clickRow("a");
    await clickRow("c", true);
    await pressAction("executing");

    expect(container.querySelector('[data-testid="bulk-count"]')?.textContent).toBe("1 selected");
    expect(checkbox("b").checked).toBe(true);
  });

  it("clears the selection entirely when every row moved", async () => {
    await mountList();
    await clickRow("a");
    await clickRow("b", true);
    await pressAction("executing");

    expect(container.querySelector('[data-testid="bulk-count"]')).toBeNull();
    // The report survives the selection it came from — it is the only
    // remaining evidence of what happened.
    expect(barText()).toContain("Moved 2 items");
  });

  it("sends nothing when the confirm on the destructive action is declined", async () => {
    // Cancel is the one action that asks first. A confirm that did not
    // actually gate the call would be theatre.
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(false));
    await mountList();
    await clickRow("a");
    await pressAction("cancelled");
    expect(transitionCalls).toHaveLength(0);
  });

  it("sends the bulk when the confirm is accepted", async () => {
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
    await mountList();
    await clickRow("a");
    await pressAction("cancelled");
    expect(transitionCalls.map((call) => call.body.to)).toEqual(["cancelled"]);
  });
});
