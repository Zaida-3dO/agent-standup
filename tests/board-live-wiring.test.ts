// @vitest-environment jsdom
//
// **The composition test for the live feed** — T17, and the second file in
// this suite that mounts real React.
//
// It exists for the reason the last visual review gave for two separate
// HIGHs: *"the units are tested, the composition isn't."* Every piece of the
// live feed is a pure function with its own thorough unit file —
// `tests/live-cursor.test.ts`, `tests/live-events.test.ts`,
// `tests/live-poll.test.ts`, `tests/live-highlight.test.ts`,
// `tests/live-conflict.test.ts` — and **all of them pass against a board that
// never subscribes to the feed at all.** A hook that is written, exported,
// unit-tested and simply never called is invisible to every one of them. So
// this file asserts the only thing they cannot: that mounting the real
// `Board` causes a real `GET /api/events` to reach the network, and that what
// comes back actually reaches the board.
//
// **StrictMode, for the reason `tests/board-react-wiring.test.ts` sets out at
// length.** React invokes updaters twice under it and defers them whenever a
// lane is already pending on the fiber — and a live feed writing a cursor
// into component state is exactly the shape that has now shipped three times
// in this repo. `scripts/check-updater-side-effects.mjs` catches the written
// form of that defect syntactically; it explicitly cannot catch the inverse,
// a handler reading a stale render value instead of a ref. This is that
// layer. Under StrictMode the mount effect runs, tears down and runs again,
// so a feed whose cleanup does not actually cancel its timer shows up here as
// a doubled poll rather than as a slow leak in production.
//
// **jsdom is scoped to this file by the docblock above**, keeping the repo's
// `environment: "node"` default intact everywhere else — the same narrow
// exception, on the same terms, that the other wiring file takes.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Board } from "@/components/board/Board";
import { emptyBoard } from "@/lib/board/view";
import type { Board as BoardData } from "@/lib/board/types";
import { POLL_INTERVAL_MS } from "@/lib/live/poll";
import { section } from "./helpers/board-sections";

vi.mock("@/lib/profile/ProfileProvider", () => ({
  useProfile: () => ({ activeProfile: { id: "person-1", name: "Test" } }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/board",
}));

/** A board with one task in Backlog — something for a live event to change. */
function boardWithOneCard(state = "on_deck"): BoardData {
  return {
    ...emptyBoard(),
    backlog: section([
      {
        item: {
          id: "item-a",
          title: "A card",
          headline: null,
          kind: "task",
          state,
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
        subtasks: null,
      },
    ]),
  };
}

/** Every `GET /api/events` the component issued, with the cursor it asked from. */
const eventCalls: { url: string; since: string | null }[] = [];
/** Every transition request, so the conflict case can prove one was sent. */
const transitionCalls: { url: string; body: unknown }[] = [];
/** Board reads, so a test can prove a live event caused a refetch. */
let boardReads = 0;

/**
 * The slice the next `GET /api/events` answers with, and the cursor it
 * reports. Set by a test; reset in `beforeEach` so nothing is inherited.
 */
let nextEvents: unknown[] = [];
let nextCursor = "0";
/** Makes the next transition come back as a 409 conflict. */
let conflictNextTransition = false;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  eventCalls.length = 0;
  transitionCalls.length = 0;
  boardReads = 0;
  nextEvents = [];
  nextCursor = "0";
  conflictNextTransition = false;
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);

      // `/api/ui/events` — every front-end request goes through the UI
      // proxy prefix (`uiApiPath`), because a browser call carries no
      // credential of its own.
      if (url.includes("/api/ui/events")) {
        const parsed = new URL(url, "http://localhost");
        eventCalls.push({ url, since: parsed.searchParams.get("since") });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ events: nextEvents, cursor: nextCursor }),
        } as Response);
      }

      if (url.includes("/api/ui/board")) {
        boardReads += 1;
        const parsed = new URL(url, "http://localhost");
        const column = parsed.searchParams.get("column") ?? "backlog";
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
        transitionCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as unknown });
        if (conflictNextTransition) {
          conflictNextTransition = false;
          // The real envelope: `StaleTransitionError` is a `ConflictError`,
          // and `respond.ts` spreads its `details` alongside the message.
          return Promise.resolve({
            ok: false,
            status: 409,
            json: () =>
              Promise.resolve({
                error: {
                  message: "item-a is in in_review, not on_deck.",
                  code: "conflict",
                  fields: ["expectedFrom"],
                  details: {
                    itemId: "item-a",
                    expectedFrom: "on_deck",
                    currentState: "in_review",
                  },
                },
              }),
          } as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              item: { ...boardWithOneCard().backlog.entries[0]?.item, state: "executing" },
            }),
        } as Response);
      }

      // The filter vocabularies and saved views, fetched once on mount.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      } as Response);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Mounts `Board` under StrictMode and lets the mount-time board load resolve. */
async function mountBoard(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(StrictMode, null, createElement(Board)));
  });
  // The board load resolves as a microtask chain; let it settle so `status`
  // reaches "loaded" and the feed is enabled.
  await act(async () => {
    await Promise.resolve();
  });
}

/** Advances past one poll interval and lets its response settle. */
async function tickPoll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
  });
}

/** A `state_change` row as `GET /api/events?full=true` returns it. */
function stateChangeEvent(over: Record<string, unknown> = {}) {
  return {
    id: "12",
    itemId: "item-a",
    itemTitle: "A card",
    ts: new Date().toISOString(),
    type: "state_change",
    actorType: "agent",
    actorId: "bunmi-4c7",
    sessionId: "s-9",
    payload: { from: "on_deck", to: "in_review" },
    ...over,
  };
}

describe("the live feed, mounted in real React", () => {
  it("renders the loaded board, so the assertions below are not vacuous", async () => {
    // Guards the guard: if the mount or the fixture broke, this fails first
    // and names why, rather than every later assertion passing on an empty
    // page.
    await mountBoard();
    expect(container.querySelector('[draggable="true"]')).not.toBeNull();
  });

  it("polls the events endpoint after mounting", async () => {
    // **The assertion this file exists for.** Every unit test of the poll,
    // the cursor and the delta reducer passes with the hook never called; this
    // is zero calls if `Board` does not mount `useLiveBoard`.
    await mountBoard();
    expect(eventCalls).toHaveLength(0); // the first poll is scheduled, not immediate

    await tickPoll();
    expect(eventCalls.length).toBeGreaterThan(0);
  });

  it("asks from the cursor the server last reported, not from zero each time", async () => {
    // The "no duplicated events" half of the row's criterion, at the wiring
    // level: a hook that held its cursor in a `setState` updater and read it
    // back on the next tick would re-ask from 0 forever, and every pure test
    // of `advanceCursor` would still pass.
    await mountBoard();
    nextCursor = "12";
    nextEvents = [stateChangeEvent()];
    await tickPoll();

    nextEvents = [];
    await tickPoll();

    const asked = eventCalls.map((call) => call.since);
    expect(asked[0]).toBe("0");
    expect(asked[asked.length - 1]).toBe("12");
  });

  it("re-reads the board when another session changes an item", async () => {
    // "The board updates without a reload when another session changes an
    // item" — the row's first criterion, asserted end to end.
    await mountBoard();
    const before = boardReads;

    nextCursor = "12";
    nextEvents = [stateChangeEvent()];
    await tickPoll();

    expect(boardReads).toBeGreaterThan(before);
  });

  it("does not re-read the board for an event that changes nothing on a card", async () => {
    // Agents write notes and checkpoints constantly; a refetch per note would
    // be a full board read several times a second.
    await mountBoard();
    const before = boardReads;

    nextCursor = "13";
    nextEvents = [stateChangeEvent({ type: "note", payload: {} })];
    await tickPoll();

    expect(boardReads).toBe(before);
  });

  it("highlights the card another session changed", async () => {
    // "Changed cards are briefly highlighted" — asserted through the real
    // render, so a prop threaded to the wrong component fails here.
    await mountBoard();
    expect(container.querySelector("[data-changed]")).toBeNull();

    nextCursor = "12";
    nextEvents = [stateChangeEvent()];
    await tickPoll();

    expect(container.querySelector("[data-changed]")).not.toBeNull();
  });

  it("stops highlighting once the mark expires", async () => {
    await mountBoard();
    nextCursor = "12";
    nextEvents = [stateChangeEvent()];
    await tickPoll();
    expect(container.querySelector("[data-changed]")).not.toBeNull();

    nextEvents = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });

    expect(container.querySelector("[data-changed]")).toBeNull();
  });

  it("stops polling once unmounted", async () => {
    // A StrictMode mount runs the effect, tears it down and runs it again, so
    // a cleanup that does not actually clear its timer leaks a poll loop per
    // mount. This is where that shows up.
    await mountBoard();
    await tickPoll();

    await act(async () => {
      root.unmount();
    });
    const after = eventCalls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    });
    expect(eventCalls).toHaveLength(after);

    // `afterEach` unmounts again; re-rooting keeps that a no-op rather than a
    // throw on an already-unmounted root.
    root = createRoot(document.createElement("div"));
  });
});

describe("a conflicting move, mounted in real React", () => {
  /**
   * Drags the card onto In Progress, exactly as `board-react-wiring.test.ts`
   * does — see its `dragCardTo` for why `dragenter` and `drop` share one
   * `act`.
   */
  async function dragCardToInProgress(): Promise<void> {
    const card = container.querySelector<HTMLElement>('[draggable="true"]');
    if (!card) throw new Error("no draggable card rendered — the fixture is wrong, not the code");
    const target = container.querySelector<HTMLElement>('[data-column="in_progress"]');
    if (!target) throw new Error("no in_progress column rendered");

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
    await act(async () => {
      fire(target, "dragenter");
      fire(target, "dragover");
      fire(target, "drop");
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("names who moved it, where to, and how long ago", async () => {
    // The row's third criterion, end to end: the 409's `details` and the live
    // feed's slice have to meet in the component for this sentence to exist.
    // Neither `conflictMessage` nor `move.ts` can be shown to do this alone.
    await mountBoard();

    // The feed sees the other session's move first — this is what supplies
    // the attribution.
    nextCursor = "12";
    nextEvents = [stateChangeEvent()];
    await tickPoll();

    conflictNextTransition = true;
    nextEvents = [];
    await dragCardToInProgress();

    expect(transitionCalls.length).toBeGreaterThan(0);
    const refusal = container.querySelector("[data-refusal]");
    expect(refusal).not.toBeNull();
    const message = refusal?.getAttribute("data-refusal") ?? "";
    expect(message).toContain("bunmi-4c7");
    expect(message).toContain("in review");
    expect(message).toMatch(/ago/);
  });

  it("reconciles the card to the server's state instead of reverting it", async () => {
    // A conflict means the item really did move. Snapping the card back to
    // Backlog would be a second wrong answer shown confidently.
    await mountBoard();
    conflictNextTransition = true;
    await dragCardToInProgress();

    // Located by the column each card sits in rather than by an id
    // attribute, because the card does not carry one — and adding one purely
    // so a test could find it would be a production attribute existing for
    // the test's benefit.
    const inProgress = container.querySelector('[data-column="in_progress"]');
    const backlog = container.querySelector('[data-column="backlog"]');
    expect(inProgress?.textContent).toContain("A card");
    expect(backlog?.textContent).not.toContain("A card");
  });
});
