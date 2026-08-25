// @vitest-environment jsdom
//
// The composition half of MILESTONES.md #38 — the second file in this suite
// that mounts real React, and it exists for the same reason
// `tests/board-react-wiring.test.ts` does.
//
// `tests/since-view-component.test.ts` covers `SinceLastVisitView` and
// `tests/since-state.test.ts` covers `fetchFeed`/`markSeen`/`applySeen`, and
// both are thorough. But every one of them calls a **pure** function: the
// view takes its `loadState` as a prop, and the state module takes its
// `fetch` as an argument. Neither can reach the part of this feature that has
// no pure form — `SinceLastVisit.tsx`, where a profile becomes a fetch, a
// resolved promise becomes rendered state, and a button press becomes a
// `POST` whose result is folded back into a `setLoaded` updater.
//
// That gap is not theoretical. The defect `scripts/check-updater-side-effects.mjs`
// exists for has shipped three times in this repo (#128 twice, `UndoToastHost`
// once), and each time the pure functions being composed were individually
// correct and individually green. A composition defect is only visible to a
// test that composes, so this file drives the real container through
// `react-dom/client` under jsdom and asserts on what a reader would see.
//
// **Why jsdom is scoped to this file** rather than set in `vitest.config.ts`:
// the repo is deliberately `environment: "node"` with no DOM, which is what
// keeps component logic in the extracted seams where it can be tested without
// one. The docblock above opts this file in alone, and that stays the
// exception — the assertions here are about *wiring* (which request was
// issued, for whom, and what the list said afterwards), never about styling.
import { createElement, StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SinceLastVisit } from "@/components/since/SinceLastVisit";
import type { SinceEvent, SinceFeed } from "@/lib/since/types";

// The active profile is the input this whole component keys on, so unlike
// `board-react-wiring`'s fixed stub this one is a mutable let: the
// profile-switch case below changes it between renders, which is exactly the
// scenario `personId` in the effect's dependency list exists for.
let activeProfileId: string | null = "person-a";
vi.mock("@/lib/profile/ProfileProvider", () => ({
  useProfile: () => ({
    activeProfile: activeProfileId === null ? null : { id: activeProfileId, name: activeProfileId },
  }),
}));

/** One event, seen by nobody, attributed to an item so it renders under a heading. */
function unseenEvent(id: string, overrides: Partial<SinceEvent> = {}): SinceEvent {
  return {
    id,
    itemId: "item-1",
    itemTitle: "A tracked item",
    ts: "2026-08-25T10:00:00.000Z",
    actorType: "agent",
    actorId: "agent-1",
    type: "checkpoint",
    seen: false,
    seenByAnyone: false,
    ...overrides,
  };
}

function feedOf(events: readonly SinceEvent[], overrides: Partial<SinceFeed> = {}): SinceFeed {
  return {
    events,
    cursor: events.length > 0 ? events[events.length - 1]!.id : "0",
    horizon: "9999",
    unseenCount: events.reduce((n, e) => (e.seen ? n : n + 1), 0),
    firstVisit: false,
    ...overrides,
  };
}

/** Every `GET /api/ui/events` the component issued, in order. */
let feedCalls: { url: string; personId: string | null }[] = [];
/** Every `POST /api/ui/events/{id}/seen`, with the id and the profile it was attributed to. */
let seenCalls: { eventId: string; personId: unknown }[] = [];
/** What the next feed fetch resolves to, keyed by the `personId` the request carried. */
let feedByPerson: Map<string | null, SinceFeed>;
/** Resolvers for in-flight feed fetches, so a test can control ordering. */
let pendingFeeds: { personId: string | null; resolve: () => void }[] = [];
/** When true, feed fetches wait for a test to release them rather than resolving immediately. */
let holdFeeds = false;
let failSeenWith: number | null = null;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React 19 reads this to decide it is in a test environment; without it
  // `act` warns and the scheduling paths driven here are not the real ones.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  activeProfileId = "person-a";
  feedCalls = [];
  seenCalls = [];
  pendingFeeds = [];
  holdFeeds = false;
  failSeenWith = null;
  feedByPerson = new Map<string | null, SinceFeed>([
    [null, feedOf([])],
    ["person-a", feedOf([unseenEvent("10"), unseenEvent("11")])],
  ]);
  container = document.createElement("div");
  document.body.appendChild(container);

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      const parsed = new URL(url, "http://localhost");

      // The seen write. Matched before the feed read because its path is a
      // sub-path of it.
      const seenMatch = /\/events\/([^/]+)\/seen$/.exec(parsed.pathname);
      if (seenMatch) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { personId?: unknown };
        seenCalls.push({
          eventId: decodeURIComponent(seenMatch[1]!),
          personId: body.personId,
        });
        if (failSeenWith !== null) {
          const status = failSeenWith;
          return Promise.resolve({ ok: false, status } as Response);
        }
        return Promise.resolve({ ok: true, status: 200 } as Response);
      }

      if (parsed.pathname.endsWith("/events")) {
        // `personId` is read off the URL rather than off `activeProfileId`,
        // so a request issued for the previous profile still answers with
        // that profile's feed even after the component has moved on. That is
        // what makes the out-of-order case below a real race rather than a
        // stub that quietly agrees with whatever the component last did.
        const personId = parsed.searchParams.get("personId");
        feedCalls.push({ url, personId });
        const feed = feedByPerson.get(personId) ?? feedOf([]);
        const response = {
          ok: true,
          status: 200,
          json: () => Promise.resolve(feed),
        } as Response;
        if (!holdFeeds) return Promise.resolve(response);
        return new Promise<Response>((resolve) => {
          pendingFeeds.push({ personId, resolve: () => resolve(response) });
        });
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

/** Mounts the real container under StrictMode and lets its mount-time fetch settle. */
async function mountSince(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(StrictMode, null, createElement(SinceLastVisit)));
  });
}

/** The rendered rows, as a reader meets them. */
function rows(): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-event-id]"));
}

function rowFor(eventId: string): HTMLElement | undefined {
  return rows().find((row) => row.dataset.eventId === eventId);
}

/** The "Mark seen" button on one row, if it is offering one. */
function markSeenButton(eventId: string): HTMLButtonElement | null {
  return rowFor(eventId)?.querySelector<HTMLButtonElement>("button") ?? null;
}

function markAllButton(): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "Mark all as seen",
  );
}

describe("SinceLastVisit — the feed is fetched for the active profile", () => {
  it("asks for the active profile's read state on mount, and renders what came back", async () => {
    await mountSince();

    // AC1: per person, not globally. The `personId` on the wire is the whole
    // point — a feed fetched without one reports everything unseen for
    // everybody, which is a different feature.
    expect(feedCalls.length).toBeGreaterThan(0);
    expect(feedCalls.every((call) => call.personId === "person-a")).toBe(true);
    expect(rows()).toHaveLength(2);
  });

  it("re-fetches for the new profile when the reader switches, and shows that profile's feed", async () => {
    // The defect this kills: `personId` missing from the effect's dependency
    // list. Every `seen` flag on screen would then still be person-a's while
    // the top bar says person-b — one person's inbox displayed as another's,
    // which is the exact failure SCHEMA.md §8b's per-person read state exists
    // to prevent.
    feedByPerson.set("person-b", feedOf([unseenEvent("20", { itemTitle: "B's item" })]));
    await mountSince();
    const callsBefore = feedCalls.length;

    activeProfileId = "person-b";
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(SinceLastVisit)));
    });

    expect(feedCalls.length).toBeGreaterThan(callsBefore);
    expect(feedCalls.at(-1)?.personId).toBe("person-b");
    expect(rows()).toHaveLength(1);
    expect(rowFor("20")).toBeDefined();
    // person-a's events are gone rather than lingering beneath person-b's.
    expect(rowFor("10")).toBeUndefined();
  });

  it("does not paint a late response for the previous profile over the current one", async () => {
    // The cancellation guard, driven as the race it defends against: the
    // person-a fetch is still in flight when the reader switches, and it
    // resolves *after* person-b's. Without `cancelled`, the stale response
    // wins because it settled last.
    feedByPerson.set("person-b", feedOf([unseenEvent("20", { itemTitle: "B's item" })]));
    holdFeeds = true;
    await act(async () => {
      root = createRoot(container);
      root.render(createElement(StrictMode, null, createElement(SinceLastVisit)));
    });

    activeProfileId = "person-b";
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(SinceLastVisit)));
    });

    // person-b's response lands first, then person-a's stale one.
    const forB = pendingFeeds.filter((p) => p.personId === "person-b");
    const forA = pendingFeeds.filter((p) => p.personId === "person-a");
    expect(forB.length).toBeGreaterThan(0);
    expect(forA.length).toBeGreaterThan(0);
    await act(async () => {
      for (const p of forB) p.resolve();
    });
    await act(async () => {
      for (const p of forA) p.resolve();
    });

    expect(rowFor("20")).toBeDefined();
    expect(rowFor("10")).toBeUndefined();
  });
});

describe("SinceLastVisit — the seen action", () => {
  it("sends the write for the pressed event, attributed to the active profile", async () => {
    await mountSince();

    await act(async () => {
      markSeenButton("10")?.click();
    });

    // AC2: a seen action that actually marks things seen. The request
    // reaching the network is the half no pure test can see — `applySeen`
    // updating a feed it was handed proves nothing about whether anything
    // was ever sent.
    expect(seenCalls).toEqual([{ eventId: "10", personId: "person-a" }]);
  });

  it("clears the row's unseen state and drops the count, without re-fetching the feed", async () => {
    await mountSince();
    const feedCallsBefore = feedCalls.length;

    await act(async () => {
      markSeenButton("10")?.click();
    });

    // The `setLoaded` updater actually folded the result back in. This is
    // the assertion that fails if the update is written as a side effect
    // assigned inside the updater and read outside it — the defect
    // `scripts/check-updater-side-effects.mjs` guards statically and this
    // guards behaviourally.
    expect(rowFor("10")?.dataset.seen).toBe("true");
    expect(rowFor("11")?.dataset.seen).toBe("false");
    // A row that is seen stops offering the action, so the button whose only
    // possible effect is nothing is not shown.
    expect(markSeenButton("10")).toBeNull();
    expect(container.querySelector('[aria-label="1 unseen"]')).not.toBeNull();
    // AC3, from the client's side: the list is updated in place rather than
    // re-paged under the reader's cursor.
    expect(feedCalls).toHaveLength(feedCallsBefore);
  });

  it("marks every unseen event when the reader clears the list at once", async () => {
    await mountSince();

    await act(async () => {
      markAllButton()?.click();
    });

    expect(seenCalls.map((call) => call.eventId).sort()).toEqual(["10", "11"]);
    expect(rows().every((row) => row.dataset.seen === "true")).toBe(true);
    // Nothing is left unseen, so neither the count nor the bulk action remains.
    expect(container.querySelector('[aria-label="1 unseen"]')).toBeNull();
    expect(markAllButton()).toBeUndefined();
  });

  it("tells the reader when the write failed, rather than showing it as seen", async () => {
    // The dishonest failure is the one worth pinning: a list that marks the
    // row seen locally and swallows a rejected write tells the reader they
    // have dealt with something the server still considers unread.
    failSeenWith = 500;
    await mountSince();

    await act(async () => {
      markSeenButton("10")?.click();
    });

    expect(seenCalls).toHaveLength(1);
    expect(rowFor("10")).toBeUndefined();
    expect(container.textContent).toContain("Could not mark that as seen");
  });

  it("offers no seen action when no profile is active, since there is nobody to attribute it to", async () => {
    activeProfileId = null;
    feedByPerson.set(null, feedOf([unseenEvent("10")]));
    await mountSince();

    // The feed is still readable — "seen" is simply meaningless without a
    // person, so the request carries no `personId` and the action is absent.
    expect(feedCalls.every((call) => call.personId === null)).toBe(true);
    expect(rowFor("10")).toBeDefined();
    expect(markSeenButton("10")).toBeNull();
    expect(markAllButton()).toBeUndefined();
  });
});
