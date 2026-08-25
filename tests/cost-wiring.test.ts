// @vitest-environment jsdom
//
// **The cost screen, mounted in real React** — the third file in this suite
// to do that, and it exists for the reason the first two record.
//
// `tests/undo-toast-host-wiring.test.ts` documents a PR that passed 34 of 34
// hand-mutants and still shipped two defects, because every mutant tested a
// pure function and the pure functions were all correct. The defect was in
// the composition — the thirty lines that call them in order. As that review
// put it: the suite is green **and** both defects shipped; the units are
// tested, the composition is not.
//
// `tests/cost-view.test.ts` is this screen's pure layer, and it is in exactly
// that position: it proves `buildCostsQuery` builds the right URL and
// `totalOf` sums correctly, and it would go on passing if `Cost.tsx` never
// called either of them, or called them once and then ignored the controls.
//
// So this file asserts the three things no unit test here can reach:
//
//   1. mounting the container **issues a request at all**;
//   2. changing a control **issues a new one, for the new parameters**;
//   3. a failed load reaches the reader as a message rather than a blank
//      screen or an unhandled rejection.
//
// ── StrictMode, and what it is pinning ──────────────────────────────────
//
// Mounted under `StrictMode` for the same reason the undo test is: React
// double-invokes effects and updaters, which is what turned that bug from
// intermittent into reproducible. Here it also pins something specific to
// this component — the load state is tagged with the request it belongs to
// and compared during render, rather than reset with a synchronous
// `setState` inside the effect. Under StrictMode a reset-in-effect renders
// the stale table before clearing it, which is both the flash of wrong data
// and what `react-hooks/set-state-in-effect` warns about.
//
// **Why jsdom lives in this file rather than in `vitest.config.ts`.** The
// repo is deliberately `environment: "node"` with no DOM library, and that
// is worth keeping: it is what stops component logic drifting back out of
// the testable seams it was extracted into. The docblock above scopes the
// DOM to this file alone. It asserts *that the right request is issued* and
// *that the result reaches the screen*, not what the screen looks like.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cost } from "@/components/cost/Cost";

/** Every request that reached the stubbed network, in order. */
const requests: string[] = [];

/** What the next response should be. Mutable so a case can make one fail. */
let respondWith: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: {
    groupBy: "day",
    groups: [
      {
        key: "2026-03-01",
        runs: 2,
        toolCalls: 5,
        inputTokens: 1000,
        outputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        cost: 3.5,
        unpricedRuns: 0,
      },
    ],
    truncated: false,
    unpricedModels: [],
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths are not the ones we mean to drive.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  requests.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input);
      requests.push(url);
      return Promise.resolve({
        ok: respondWith.ok,
        status: respondWith.status,
        json: () => Promise.resolve(respondWith.body),
      } as Response);
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  respondWith = { ...respondWith, ok: true, status: 200 };
});

/** Mounts the real component under StrictMode and lets its effects settle. */
async function mount(props: Record<string, unknown> = {}) {
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Cost, props)));
  });
}

/** Clicks the button whose visible text is `label`, and lets the result settle. */
async function click(label: string) {
  // `Array.from` rather than a spread: the repo's `lib` target does not
  // include the DOM iterable declarations, so spreading a `NodeListOf` does
  // not typecheck even though it works at runtime.
  const buttons = Array.from(container.querySelectorAll("button"));
  const button = buttons.find((candidate) => candidate.textContent?.trim() === label);
  if (!button) {
    throw new Error(
      `No button labelled "${label}". Present: ${buttons
        .map((b) => b.textContent?.trim())
        .join(", ")}`,
    );
  }
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the cost screen, wired", () => {
  it("issues a request on mount", async () => {
    // Restore-the-defect check: with the `fetchCosts` call removed from the
    // effect, `requests` stays empty and this fails — while every assertion
    // in `cost-view.test.ts` still passes, because `buildCostsQuery` is
    // still perfectly correct on its own.
    await mount();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]).toContain("/costs?");
  });

  it("opens on the day grouping, which is the question the screen answers", async () => {
    await mount();
    expect(requests[0]).toContain("groupBy=day");
  });

  it("renders what came back, so the response reaches the screen", async () => {
    await mount();
    // The figure from the stubbed body, formatted. Asserting the *rendered*
    // total rather than the state proves the payload travelled all the way
    // through the container into the view.
    expect(container.textContent).toContain("$3.50");
  });

  it("issues a new request for a new grouping when a chip is pressed", async () => {
    // The wiring most likely to be silently broken: a handler that updates
    // state the effect does not depend on would change the highlighted chip
    // and never refetch, leaving a previous grouping's totals under the
    // newly-selected heading.
    await mount();
    const before = requests.length;
    await click("Project");
    expect(requests.length).toBeGreaterThan(before);
    expect(requests[requests.length - 1]).toContain("groupBy=project");
  });

  it("issues a new request when the window changes", async () => {
    await mount();
    const before = requests.length;
    await click("7 days");
    expect(requests.length).toBeGreaterThan(before);
    // A narrower window sends a lower bound; the all-time default does not.
    expect(requests[requests.length - 1]).toContain("since=");
  });

  it("sends no lower bound for all time", async () => {
    await mount();
    await click("All time");
    expect(requests[requests.length - 1]).not.toContain("since=");
  });

  it("shows a failed load as a message rather than a blank screen", async () => {
    // Without the `.catch`, this is an unhandled rejection and the screen
    // sits on "Loading costs…" forever — which reads as a slow server rather
    // than a broken one.
    respondWith = { ...respondWith, ok: false, status: 500 };
    await mount();
    expect(container.textContent).toContain("500");
    expect(container.textContent).not.toContain("Loading costs…");
  });

  it("does not render stale totals under a new heading while the next load is in flight", async () => {
    // The specific hazard the request-tagged state exists to prevent, and
    // the reason it is compared during render rather than reset in an
    // effect. A reset-in-effect paints the previous grouping's rows under
    // the new grouping's caption for one frame.
    //
    // Driven by holding the second response open, so the in-flight window is
    // a real state the test can observe rather than a frame it must race.
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input);
        requests.push(url);
        if (url.includes("groupBy=session")) {
          return new Promise<Response>((resolve) => {
            release = () =>
              resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ ...(respondWith.body as object), groups: [] }),
              } as Response);
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(respondWith.body),
        } as Response);
      }),
    );

    await mount();
    expect(container.textContent).toContain("$3.50");

    await click("Session");
    // Mid-flight: the day grouping's figure must be gone, not sitting under
    // the session grouping's heading.
    expect(container.textContent).toContain("Loading costs…");
    expect(container.textContent).not.toContain("$3.50");

    await act(async () => {
      release?.();
    });
  });
});
