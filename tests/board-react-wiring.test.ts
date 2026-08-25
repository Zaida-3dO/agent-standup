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
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Board } from "@/components/board/Board";
import { UndoToastHost } from "@/components/toast";
import { emptyBoard } from "@/lib/board/view";
import type { Board as BoardData } from "@/lib/board/types";
import { section } from "./helpers/board-sections";

// `Board` reads the active profile from context. The drag handlers are wired
// regardless of who is active, so a fixed stub keeps this file about
// scheduling rather than about profiles.
vi.mock("@/lib/profile/ProfileProvider", () => ({
  useProfile: () => ({ activeProfile: { id: "person-1", name: "Test" } }),
}));

// `Board` reads its filters out of the URL and navigates to change them
// (#75), which needs the app router mounted — and mounting a real router here
// would drag Next's whole navigation runtime into a file that exists to test
// React's update scheduling. The stub is an unfiltered board in the default
// order, which is the state every assertion below already assumed.
//
// **`useSearchParams` returns a real `URLSearchParams`**, not a bare object
// with a `get`: `Board` calls `.toString()` on it to key the load effect, so
// a stub missing that method would fail for a reason that has nothing to do
// with what these tests check.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/board",
}));

/** A board with one task in Backlog, so it has somewhere to be dragged to. */
function boardWithOneCard(): BoardData {
  return {
    ...emptyBoard(),
    backlog: section([
      {
        item: {
          id: "item-a",
          title: "A card",
          headline: null,
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
        assignments: [],
        trust: null,
        // A rollup, so the card renders its subtask disclosure control —
        // the subject of the expansion case at the bottom of this file. The
        // drag cases above are indifferent to it.
        subtasks: { total: 2, done: 1 },
      },
    ]),
  };
}

/**
 * Stubs `fetch` for both kinds of call the component makes: the mount-time
 * board reads, and the `POST /api/items/:id/transition` a drop issues.
 *
 * The board is fetched **one column per request** (MILESTONES.md #109), so
 * the stub answers whichever column the URL names rather than returning a
 * whole board to every caller — returning all four columns to each of four
 * requests would render every card four times.
 *
 * Stubbed at `fetch` rather than by mocking `@/lib/board/move`, deliberately:
 * the assertion is that a **transition request reaches the network**, and
 * mocking the module that builds it would move the boundary above the wiring
 * this file exists to test.
 */
const transitionCalls: { url: string; body: unknown }[] = [];

/**
 * Makes the next transition request come back 409, so a test can drive the
 * refusal path. One-shot and reset in `beforeEach`, so no test inherits it.
 */
let refuseNextTransition = false;
/** Every subtree-scoped board read — i.e. every subtask expansion fetch. */
const subtaskCalls: { url: string; parentId: string }[] = [];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  transitionCalls.length = 0;
  refuseNextTransition = false;
  subtaskCalls.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url.includes("/api/ui/board")) {
        const parsed = new URL(url, "http://localhost");
        const column = parsed.searchParams.get("column") ?? "backlog";
        // A board read scoped to one row's subtree is an EXPANSION fetch,
        // not the mount-time board load — `project` is the parameter that
        // tells them apart, and recording it here is what lets the case at
        // the bottom assert the press reached the network.
        const scopedTo = parsed.searchParams.get("project");
        if (scopedTo !== null) {
          subtaskCalls.push({ url, parentId: scopedTo });
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                board: {
                  columns: {
                    [column]:
                      column === "backlog"
                        ? {
                            entries: [
                              {
                                item: {
                                  ...boardWithOneCard().backlog.entries[0]?.item,
                                  id: "kid-1",
                                  title: "A subtask of the card",
                                },
                                column: "backlog",
                                assignments: [],
                                trust: null,
                                subtasks: null,
                              },
                            ],
                            total: 1,
                            nextCursor: null,
                            withheld: false,
                          }
                        : { entries: [], total: 0, nextCursor: null, withheld: false },
                  },
                },
              }),
          } as Response);
        }
        const board = boardWithOneCard();
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              board: { columns: { [column]: board[column as keyof typeof board] } },
            }),
        } as Response);
      }
      if (url.includes("/transition")) {
        transitionCalls.push({
          url,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        // One-shot, so a refusal is opt-in per test and never leaks into the
        // next one — `beforeEach` resets it.
        if (refuseNextTransition) {
          refuseNextTransition = false;
          return Promise.resolve({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: { message: "Someone else moved this." } }),
          } as Response);
        }
        // A whole item, as the real endpoint returns: `requestMove` hands it
        // to `reconcile`, which puts it on the board verbatim. A half-item
        // here would crash the render on a missing field and look like a
        // component bug rather than a fixture one.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              item: { ...boardWithOneCard().backlog.entries[0]?.item, state: "executing" },
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

/**
 * Mounts `Board` **under StrictMode** and lets the mount-time board load
 * resolve.
 *
 * **StrictMode is the whole point of this helper, and it was missing.** The
 * subtask tests below were written with a plain `createRoot(...).render(Board)`
 * and passed for a feature that never worked: `onToggleExpanded` assigned
 * `opening` inside a `setExpandedIds` updater and read it on the next line, so
 * no subtask request was ever sent and the card sat on "Loading subtasks…"
 * forever. Without StrictMode React invoked the updater eagerly exactly once,
 * `opening` was set in time, and every assertion here passed — which is how the
 * third occurrence of #128 shipped behind a green suite.
 *
 * StrictMode invokes updaters twice, so the second pass sees a `current` the
 * handler has already advanced and takes the opposite branch. That is what
 * makes an outer variable written inside an updater observably wrong here,
 * and it is the same mechanism `tests/undo-toast-host-wiring.test.ts`
 * documents at length for the second occurrence.
 *
 * It is not the only mechanism, and the fix does not depend on this one
 * reproducing: React also defers an updater whenever a lane is already
 * pending on the fiber, which on this component is essentially always. Both
 * roads end at the same place — the value is not there when the next line
 * reads it — so the ref is required either way.
 */
async function mountBoard(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(StrictMode, null, createElement(Board)));
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
    expect(transitionCalls[0]?.url).toContain("/api/ui/items/item-a/transition");
    // `full: true` — the board needs the whole record to reconcile the card
    // it just moved; see `board/move.ts` and `tests/board-move.test.ts`.
    //
    // `expectedFrom: "on_deck"` is the card's state in the mounted fixture,
    // i.e. the state the *server* reported at the last board read — see the
    // dedicated case below for why this key being present is load-bearing.
    expect(transitionCalls[0]?.body).toEqual({
      to: "executing",
      full: true,
      expectedFrom: "on_deck",
    });
  });

  it("sends expectedFrom from a real drag, so a lost race is refused rather than overwriting", async () => {
    // **The assertion that closes the silent-overwrite defect.**
    //
    // `applyTransition` raises `StaleTransitionError` only when the caller
    // supplied an `expectedFrom` (`state-machine/transition.ts`): without the
    // key the server moves the item from whatever state it holds and answers
    // 200. A drag that loses a race therefore overwrites the other session in
    // silence, and every 409 path the board owns — `conflictDetailsFrom`,
    // `conflictEntry`, `moveConflicted`, the 409 arm of `refusalMessage` —
    // is unreachable code that cannot run in production.
    //
    // **Why this assertion belongs in this file specifically.** A test of
    // `requestMove` alone proves the parameter is serialised when passed; a
    // test of `handleDrop` alone proves the seam forwards what it is handed.
    // Neither can fail if the *component* stops supplying it, and the
    // composition is exactly where the defect lived. This drives the real
    // `Board` under StrictMode through a real drag to the real stubbed
    // network, so it fails if any link in that chain drops the key.
    //
    // **The value is checked, not just the presence.** `expectedFrom` has to
    // be the server's reported state for the card — `on_deck` in the fixture
    // — and asserting only `toHaveProperty` would pass for a caller that sent
    // the *target* state, or the source column's name, either of which makes
    // the precondition compare the wrong two things and never fire.
    await mountBoard();
    await dragCardTo("in_progress");

    expect(transitionCalls).toHaveLength(1);
    const body = transitionCalls[0]?.body as Record<string, unknown> | undefined;
    expect(body).toBeDefined();
    expect(Object.keys(body ?? {})).toContain("expectedFrom");
    expect(body?.expectedFrom).toBe("on_deck");
    // Not the destination, and not the column id. Named explicitly because
    // both are plausible wrong answers a refactor could reach for, and both
    // would leave the precondition permanently satisfied or permanently
    // broken rather than doing its job.
    expect(body?.expectedFrom).not.toBe("executing");
    expect(body?.expectedFrom).not.toBe("in_progress");
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

/**
 * The subtask disclosure, driven through real React.
 *
 * **Why this is here and not only in tests/board-subtask-card.test.ts.**
 * That file proves `ItemCard` renders a button, that the button calls its
 * handler with the right id, and that `BoardColumn` hands each card its own
 * slice of the board's maps. Every one of those can be true while the
 * feature is dead on the page: `Board` holds the state and issues the
 * fetch, and nothing below it can tell whether it was wired up at all. A
 * hand-rolled host that calls the handler directly would assert the same
 * thing twice and prove the composition not at all — which is precisely the
 * failure this file's header describes for the drag.
 *
 * So these press the actual rendered DOM node and assert on the actual
 * network call.
 */
describe("a drop offers an undo, mounted in real React", () => {
  /**
   * Mounts `Board` inside a **real** `UndoToastHost`, exactly as `AppShell`
   * does — not a stub, not a spy on `offer`.
   *
   * That is the whole point of this block. `offer` being called is not the
   * feature; a person seeing a button and being able to press it is. A test
   * that asserted on a mocked `offer` would have passed for the entire period
   * in which undo was unreachable, because the defect was precisely that the
   * real provider was never handed anything.
   */
  async function mountBoardWithToast(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(StrictMode, null, createElement(UndoToastHost, null, createElement(Board))),
      );
    });
  }

  /** The toast's Undo button, matched as `undo-toast-host-wiring` matches it. */
  function undoButton(): HTMLButtonElement | null {
    return (
      Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.startsWith("Undo"),
      ) ?? null
    );
  }

  it("shows an undo toast after a drop that the server accepted", async () => {
    // **The regression test for "undo is unreachable".**
    //
    // Before this wiring, every mention of `offer` outside the toast module
    // was a comment: the drag persisted and no toast ever appeared. Removing
    // `offerUndo` from the deps in `Board.onDrop` makes this fail — measured —
    // while every other test in this file stays green, because nothing else
    // observes the toast.
    await mountBoardWithToast();
    await dragCardTo("in_progress");

    expect(container.querySelector('[data-phase="offered"]')).not.toBeNull();
    expect(undoButton()).not.toBeNull();
  });

  it("sends the inverse transition, with expectedFrom, when the undo is pressed", async () => {
    // The undo has to reverse the move *and* carry the precondition, which is
    // what stops it clobbering a change another session made inside the
    // window. `expectedFrom` is the state the move landed on; `to` is where it
    // came from. A plan built from the wrong end of the move would still be
    // one request, so the body is asserted rather than the count alone.
    await mountBoardWithToast();
    await dragCardTo("in_progress");
    const before = transitionCalls.length;

    await act(async () => {
      undoButton()?.click();
    });

    expect(transitionCalls).toHaveLength(before + 1);
    expect(transitionCalls[before]?.body).toEqual({
      to: "on_deck",
      expectedFrom: "executing",
    });
  });

  it("offers nothing when the server refused the move", async () => {
    // An optimistic move that was reverted must not leave an undo button —
    // pressing it would write a state the item was never in. This is why the
    // offer sits inside the `result.ok` branch rather than beside the
    // optimistic write.
    refuseNextTransition = true;
    await mountBoardWithToast();
    await dragCardTo("in_progress");

    expect(container.querySelector('[data-phase="offered"]')).toBeNull();
    expect(undoButton()).toBeNull();
    // The refusal itself still has to be reported — otherwise this test would
    // also pass against a board that silently swallowed the failed move, and
    // "no toast" would be evidence of the wrong thing.
    expect(container.textContent).toContain("Someone else moved this.");
    // Exactly the drop's own request: no undo request was issued behind it.
    expect(transitionCalls).toHaveLength(1);
  });
});

describe("expanding a card's subtasks, mounted in real React", () => {
  /**
   * The disclosure control as it is really rendered — never a stand-in.
   *
   * Searched from INSIDE the card rather than from the container: the filter
   * bar also renders an `aria-expanded` button ("More filters"), and a
   * document-wide selector finds that one first. A test that pressed it
   * would report the feature broken while it worked, or — worse, had the
   * order been the other way — pass without ever touching this control.
   */
  function toggle(): HTMLElement {
    const card = container.querySelector<HTMLElement>(
      '[data-column="backlog"] li[data-tone], [data-column="backlog"] li',
    );
    const button = card?.querySelector<HTMLElement>("button[aria-expanded]");
    if (!button) {
      throw new Error(
        "no subtask disclosure rendered on the card — the fixture has no rollup, or the control is not wired",
      );
    }
    return button;
  }

  it("renders a disclosure control for a card that has subtasks", async () => {
    // Guards the guard, exactly as the drag block above does: if the badge
    // stopped rendering, this fails first and names why rather than letting
    // the cases below pass vacuously.
    await mountBoard();
    expect(toggle().textContent).toContain("2 subtasks");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * Presses the disclosure the way a reader actually reaches it: with an
   * update already pending on the board's fiber.
   *
   * **This is what makes the test able to fail, and without it the test is
   * hollow.** Measured directly: with a quiet fiber React evaluates the
   * updater eagerly, so a variable assigned inside it *is* set by the next
   * line and the defect is invisible — StrictMode's double invocation does
   * not rescue it either, because the second pass is not what the handler
   * reads. With a lane already pending React defers the updater instead and
   * the variable is still `false` when the next line reads it.
   *
   * A `dragenter` is the cheapest honest way to leave that lane: it is a real
   * gesture a reader performs on a board, it goes through `applyDrag` →
   * `setDrag` on this same component, and `dragCardTo` above relies on
   * exactly the same effect for exactly the same reason. Anything that
   * schedules a state update on `Board` would do; this one is not synthetic.
   */
  async function pressToggleWithWorkPending(): Promise<void> {
    const target = container.querySelector<HTMLElement>('[data-column="in_progress"]');
    if (!target) throw new Error("no in_progress column rendered — the fixture is wrong");
    await act(async () => {
      target.dispatchEvent(new Event("dragenter", { bubbles: true, cancelable: true }));
      toggle().click();
    });
  }

  it("fetches that card's subtasks when the control is pressed", async () => {
    // **The composition assertion.** Nothing under `Board` can prove this:
    // `ItemCard` only knows it called a function it was handed, and if
    // `Board` passed no `expansion` prop at all, every unit test in
    // tests/board-subtask-card.test.ts would still pass while a press did
    // nothing whatsoever.
    await mountBoard();
    await act(async () => {
      toggle().click();
    });

    expect(subtaskCalls).toHaveLength(4);
    // Scoped to THIS card's subtree — a fetch that dropped the scope would
    // return the whole board and render every item as this card's subtask.
    expect(subtaskCalls.every((call) => call.parentId === "item-a")).toBe(true);
    // ...and NOT narrowed to the board's level default, which would exclude
    // the very rows being asked for and return nothing every time while
    // looking like it worked.
    //
    // Asserted as "the level that arrived widens", not as "no level
    // arrived": `boardRequestParams` writes a level into EVERY request by
    // design, so absence is not a state this URL can be in, and an
    // absence-based assertion would pass only while the request was
    // malformed. `exclude:` is the widening form — it parses to no level
    // filter at all server-side.
    const levels = subtaskCalls.map((call) =>
      new URL(call.url, "http://localhost").searchParams.get("level"),
    );
    expect(levels).toEqual(["exclude:", "exclude:", "exclude:", "exclude:"]);
    // Named explicitly, because this exact value is what a `level: undefined`
    // regression would silently put back.
    expect(levels).not.toContain("include:1");
  });

  it("still sends the request when an update is already pending on the board", async () => {
    // **The regression test for #128's third occurrence.**
    //
    // The four cases around this one press the toggle on a quiet fiber, and
    // all four passed for a feature that was completely broken — deriving
    // `opening` inside the `setExpandedIds` updater and reading it on the
    // next line sends nothing, and the card sits on "Loading subtasks…"
    // forever. That is what the reviewer observed on a real page
    // (`window.fetch` instrumented, `calls: []`), and what no test here
    // could see, because a reader never presses anything on a quiet fiber.
    //
    // **Restoring the defect makes this fail** — measured, not assumed: the
    // request count goes to 0 and the "Loading subtasks…" assertion below
    // fires, while every other test in this file stays green. It is the only
    // case that distinguishes the two implementations.
    await mountBoard();
    await pressToggleWithWorkPending();

    expect(subtaskCalls.length).toBeGreaterThan(0);
    expect(subtaskCalls.every((call) => call.parentId === "item-a")).toBe(true);

    // The symptom, asserted as the reader meets it. A card that requested
    // nothing reports itself expanded and then shows the loading line with
    // nothing in flight to ever replace it — so the absence of that line is
    // the difference between "opened" and "hung".
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const card = container.querySelector<HTMLElement>('[draggable="true"]');
    expect(card?.textContent).not.toContain("Loading subtasks…");
    expect(card?.textContent).toContain("A subtask of the card");
  });

  it("shows the fetched subtasks under the card, and reports itself as expanded", async () => {
    // The request being issued is not the feature; the subtasks appearing is.
    await mountBoard();
    await act(async () => {
      toggle().click();
    });

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const card = container.querySelector<HTMLElement>('[draggable="true"]');
    // Nested INSIDE the parent card, which is what "expands in place" means.
    expect(card?.textContent).toContain("A subtask of the card");
  });

  it("collapses again on a second press, without re-fetching", async () => {
    // The cache half. A toggle that re-requested on every open would put a
    // network round trip behind a purely visual control.
    await mountBoard();
    await act(async () => {
      toggle().click();
    });
    const afterOpen = subtaskCalls.length;

    await act(async () => {
      toggle().click();
    });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const card = container.querySelector<HTMLElement>('[draggable="true"]');
    expect(card?.textContent).not.toContain("A subtask of the card");

    await act(async () => {
      toggle().click();
    });
    expect(subtaskCalls).toHaveLength(afterOpen);
    const reopened = container.querySelector<HTMLElement>('[draggable="true"]');
    expect(reopened?.textContent).toContain("A subtask of the card");
  });
});
