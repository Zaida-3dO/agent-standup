// @vitest-environment jsdom
//
// **The one file in this suite that mounts real React**, and it exists for a
// reason worth stating precisely.
//
// `tests/board-drop-handler.test.ts` covers the extracted seam
// (`src/lib/board/drop-handler.ts`) thoroughly — restoring the original defect
// *there* fails 5 of its 10 assertions. But the defect this row exists to
// prevent did not live in the seam. It lived in the **wiring into React** in
// `src/components/board/Board.tsx`: `request` was assigned inside a `setDrag`
// updater and read on the line after.
//
// React 19 evaluates a `setState` updater eagerly **only** when
// `0 === fiber.lanes && (null === alternate || 0 === alternate.lanes)`
// (`react-dom-client.development.js`). The mount-time `fetchBoard().then(...)`
// already leaves a lane on this component, so the updater deferred, `request`
// stayed `null`, `onDrop` returned early, and **the very first drop sent
// nothing** — the card moved optimistically and the move vanished on the next
// load. Worse than failing loudly, which is what the row exists to prevent.
//
// Every `tests/board-*.test.ts` file passes with that defect restored (#128),
// because none of them mount the component: a hand-rolled host that runs
// updaters inline models only the lucky fast path and cannot express the
// scheduling rule that *is* the bug. So this file drives the real thing —
// `react-dom/client` under jsdom — through a whole drag, and asserts a request
// was actually issued.
//
// **Why jsdom lives in this one file rather than in `vitest.config.ts`.** The
// repo is deliberately `environment: "node"` with no DOM library, and that is
// worth keeping: it is what stops component logic drifting back out of the
// testable seams it was extracted into. The docblock above scopes the DOM to
// this file alone, so the constraint still holds everywhere else. This is the
// exception, and it is narrow on purpose — it asserts *that the transition
// request is issued*, not what the board looks like. Rendering assertions
// belong in `BoardView`'s tests, where they need no DOM at all.
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Board } from "@/components/board/Board";
import { emptyBoard } from "@/lib/board/view";
import type { Board as BoardData } from "@/lib/board/types";

// `Board` reads the active profile from context. The drag handlers are wired
// regardless of who is active, so a fixed stub keeps this file about
// scheduling rather than about profiles.
vi.mock("@/lib/profile/ProfileProvider", () => ({
  useProfile: () => ({ activeProfile: { id: "person-1", name: "Test" } }),
}));

/** A board with one task in Backlog, so it has somewhere to be dragged to. */
function boardWithOneCard(): BoardData {
  return {
    ...emptyBoard(),
    backlog: [
      {
        item: {
          id: "item-a",
          title: "A card",
          kind: "task",
          state: "on_deck",
          priority: "P1",
          area: "test",
          repo: null,
          blockedOnPersonId: null,
          blockedOnType: null,
          blockedReason: null,
          pauseReason: null,
        },
        column: "backlog",
      },
    ],
  };
}

/**
 * Stubs `fetch` for both calls the component makes: the mount-time
 * `GET /api/board`, and the `POST /api/items/:id/transition` a drop issues.
 *
 * Stubbed at `fetch` rather than by mocking `@/lib/board/move`, deliberately:
 * the assertion is that a **transition request reaches the network**, and
 * mocking the module that builds it would move the boundary above the wiring
 * this file exists to test.
 */
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
      if (url.includes("/api/board")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ board: boardWithOneCard() }),
        } as Response);
      }
      if (url.includes("/transition")) {
        transitionCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        // A whole item, as the real endpoint returns: `requestMove` hands it
        // to `reconcile`, which puts it on the board verbatim. A half-item
        // here would crash the render on a missing field and look like a
        // component bug rather than a fixture one.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              item: { ...boardWithOneCard().backlog[0]?.item, state: "executing" },
            }),
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

/** Mounts `Board` and lets the mount-time board load resolve. */
async function mountBoard(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(Board));
  });
}

/**
 * Fires a real DOM drag sequence, exactly as a browser would: the card is
 * picked up, dragged over a column, and dropped on it.
 *
 * The `dragenter` matters and is not padding — it is what puts a *second*
 * pending update on the fiber. Deferring an updater is precisely what React
 * does when a lane is already pending, so a test that dropped without it
 * would model the lucky fast path and could pass against the defect.
 */
async function dragCardTo(column: string): Promise<void> {
  const card = container.querySelector<HTMLElement>('[draggable="true"]');
  if (!card) throw new Error("no draggable card rendered — the fixture is wrong, not the code");
  const target = container.querySelector<HTMLElement>(`[data-column="${column}"]`);
  if (!target) throw new Error(`no column ${column} rendered`);

  const dataTransfer = {
    setData: vi.fn(),
    getData: vi.fn(() => "item-a"),
    effectAllowed: "move",
    dropEffect: "move",
  };
  const fire = (element: HTMLElement, type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(event);
  };

  await act(async () => {
    fire(card, "dragstart");
  });

  // **`dragenter` and `drop` go in ONE `act`, and that is the whole point.**
  //
  // React defers an updater only when an update is already pending on the
  // fiber *at the moment the updater is queued*. Each `act` flushes, so
  // firing these in separate `act` calls leaves no lane pending by the time
  // the drop runs, React evaluates the updater eagerly, and the defect this
  // file exists to catch passes cleanly — measured: with the events split
  // across `act` calls, the original defect survives all three assertions
  // here. A browser does not flush React between a `dragenter` and the
  // `drop` that follows it, so grouping them is both the faithful sequence
  // and the one that reproduces the bug.
  await act(async () => {
    fire(target, "dragenter");
    fire(target, "dragover");
    fire(target, "drop");
  });
}

describe("Board, mounted in real React", () => {
  it("renders the loaded board, so the drag assertions below are not vacuous", async () => {
    // Guards the guard. `dragCardTo` throws rather than silently asserting on
    // an empty page, but this states the precondition directly: if the mount
    // or the fixture broke, this fails first and names why.
    await mountBoard();
    expect(container.querySelector('[draggable="true"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-column]").length).toBeGreaterThan(0);
  });

  it("issues the transition request on the very first drop", async () => {
    // **The assertion this file exists for.** With the defect restored —
    // `request` assigned inside a `setDrag` updater and read after it — this
    // is zero requests, because the updater has not run by the time it is
    // read. The whole `tests/board-*.test.ts` suite stays green through that;
    // this does not.
    await mountBoard();
    await dragCardTo("in_progress");

    expect(transitionCalls).toHaveLength(1);
    expect(transitionCalls[0]?.url).toContain("/api/items/item-a/transition");
    expect(transitionCalls[0]?.body).toEqual({ to: "executing" });
  });

  it("moves the card in the rendered board as well as sending the request", async () => {
    // The optimistic half. The defect's signature was a card that moved with
    // no request sent, so asserting only the request leaves the pair untested
    // in the other direction: a change that issued the request but stopped
    // updating the view would pass the assertion above and fail this one.
    await mountBoard();
    await dragCardTo("in_progress");

    const inProgress = container.querySelector<HTMLElement>('[data-column="in_progress"]');
    expect(inProgress?.textContent).toContain("A card");
  });
});
