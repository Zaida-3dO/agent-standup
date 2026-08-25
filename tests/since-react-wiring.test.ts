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
/**
 * Continuation pages, keyed by the `since` cursor the request carried.
 *
 * Separate from `feedByPerson` because a paging test is specifically about
 * the SECOND request differing from the first, and a stub that answers both
 * from one map cannot tell them apart — it would agree with a component that
 * re-fetched page one forever. A request carrying `since` is looked up here
 * first; anything absent falls through to an empty page, which is also the
 * real end-of-ledger answer.
 */
let pagesBySince: Map<string, SinceFeed>;
/** Every `since` value the component put on the wire, in order. */
let sinceParams: (string | null)[] = [];
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
  pagesBySince = new Map<string, SinceFeed>();
  sinceParams = [];
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
        const since = parsed.searchParams.get("since");
        feedCalls.push({ url, personId });
        sinceParams.push(since);
        // A request carrying `since` is a continuation and must be answered
        // from the page map — never from the first-page map, or the stub
        // would hand back page one again and quietly bless a component that
        // never advanced its cursor.
        const feed =
          since !== null
            ? (pagesBySince.get(since) ?? feedOf([]))
            : (feedByPerson.get(personId) ?? feedOf([]));
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

// ── Paging (row 3c25e600) ──────────────────────────────────────────────
//
// `get_events` has paged correctly since it was written; nothing consumed
// the cursor, so the view showed one screenful and stopped. These cases are
// the composition half of the fix, and they live here rather than in a pure
// test for the reason this whole file exists: the interesting part is not
// "does `appendPage` append" (a pure test covers that) but *which request
// went out, carrying which cursor, and what the list said afterwards*.

/**
 * The pager control, if the view is offering one.
 *
 * Found by its `data-loading-more` attribute rather than its text, because
 * the text is exactly what changes while a page is in flight ("Load newer
 * entries" becomes "Loading…"). A text finder would report the busy button
 * as ABSENT, making "the control is gone" and "the control is working"
 * indistinguishable — which is how the first version of these tests read a
 * label change as a disappearing button.
 */
function loadMoreButton(): HTMLButtonElement | undefined {
  return container.querySelector<HTMLButtonElement>("button[data-loading-more]") ?? undefined;
}

describe("SinceLastVisit — paging past the first screenful", () => {
  it("asks the server for the next page using the cursor it returned, not an offset", async () => {
    // AC2, and the assertion that distinguishes real keyset paging from
    // "fetch more and slice". The first feed's cursor is "11"; the
    // continuation must carry exactly that on the wire.
    pagesBySince.set("11", feedOf([unseenEvent("12"), unseenEvent("13")]));
    await mountSince();

    // The first request is not a continuation — it carries no cursor at all,
    // which is what makes the ledger start from the beginning.
    expect(sinceParams.every((since) => since === null)).toBe(true);

    await act(async () => {
      loadMoreButton()?.click();
    });

    expect(sinceParams.at(-1)).toBe("11");
    // Not a limit/offset pair — the two parameters that would mean somebody
    // reimplemented paging in the browser.
    const lastUrl = new URL(feedCalls.at(-1)!.url, "http://localhost");
    expect(lastUrl.searchParams.get("offset")).toBeNull();
  });

  it("keeps the rows already on screen and adds the page beneath them", async () => {
    // The defect worth pinning: a container that sets the new page as the
    // feed loses everything above it, and the reader watches their list
    // shorten as they ask for more of it.
    pagesBySince.set("11", feedOf([unseenEvent("12"), unseenEvent("13")]));
    await mountSince();
    expect(rows()).toHaveLength(2);

    await act(async () => {
      loadMoreButton()?.click();
    });

    expect(rows()).toHaveLength(4);
    for (const id of ["10", "11", "12", "13"]) {
      expect(rowFor(id)).toBeDefined();
    }
  });

  it("counts the unseen total over everything on screen, without double-counting", async () => {
    // AC3. `applySeen` recomputes rather than decrementing precisely so an
    // idempotent write cannot drive the count below the truth; appending had
    // to preserve that from the other direction. Summing the page's own
    // `unseenCount` onto the existing one is the mutant this kills — with
    // two unseen already shown and two arriving, a sum and a recount both
    // give four, so the page deliberately re-delivers "11" as well.
    pagesBySince.set("11", feedOf([unseenEvent("11"), unseenEvent("12")]));
    await mountSince();
    expect(container.querySelector('[aria-label="2 unseen"]')).not.toBeNull();

    await act(async () => {
      loadMoreButton()?.click();
    });

    // Three distinct events, not four: the repeated id is absorbed.
    expect(rows()).toHaveLength(3);
    expect(container.querySelector('[aria-label="3 unseen"]')).not.toBeNull();
  });

  it("keeps a locally-marked row seen when a later page re-delivers it as unseen", async () => {
    // The subtle half of AC3: the server does not know about a `seen` this
    // profile set thirty seconds ago if the page was already in flight, so
    // an append that let the incoming row win would silently un-mark
    // something the reader had just cleared.
    pagesBySince.set("11", feedOf([unseenEvent("10"), unseenEvent("12")]));
    await mountSince();

    await act(async () => {
      markSeenButton("10")?.click();
    });
    expect(rowFor("10")?.dataset.seen).toBe("true");

    await act(async () => {
      loadMoreButton()?.click();
    });

    expect(rowFor("10")?.dataset.seen).toBe("true");
  });

  it("marking seen still works on a row that arrived on a later page", async () => {
    // AC3 across a page boundary: the handler is wired to the appended rows
    // exactly as it is to the first page's, and attributed to the same
    // profile.
    pagesBySince.set("11", feedOf([unseenEvent("12")]));
    await mountSince();

    await act(async () => {
      loadMoreButton()?.click();
    });
    await act(async () => {
      markSeenButton("12")?.click();
    });

    expect(seenCalls).toEqual([{ eventId: "12", personId: "person-a" }]);
    expect(rowFor("12")?.dataset.seen).toBe("true");
  });

  it("stops offering the control once a page comes back empty", async () => {
    // `get_events` has no `nextCursor: null`; it returns the caller's own
    // cursor on an empty slice. So an empty page is the only end-of-ledger
    // signal there is, and a control that stays after it can only ever do
    // nothing.
    pagesBySince.set("11", feedOf([]));
    await mountSince();
    expect(loadMoreButton()).toBeDefined();

    await act(async () => {
      loadMoreButton()?.click();
    });

    expect(loadMoreButton()).toBeUndefined();
    // Nothing was appended, and nothing was lost either.
    expect(rows()).toHaveLength(2);
  });

  it("disables the control while a page is in flight", async () => {
    // The first line of defence, and the only one a reader meets. Asserted
    // on the attribute rather than by clicking twice, because a `disabled`
    // button swallows a synthetic `.click()` in jsdom — so a two-click test
    // proves the attribute is set and says nothing whatever about the
    // handler's own guard. That guard gets its own test below.
    pagesBySince.set("11", feedOf([unseenEvent("12")]));
    await mountSince();
    expect(loadMoreButton()?.disabled).toBe(false);

    holdFeeds = true;
    await act(async () => {
      loadMoreButton()?.click();
    });

    expect(loadMoreButton()?.disabled).toBe(true);
    expect(loadMoreButton()?.dataset.loadingMore).toBe("true");
    // The label says so too, which is the half a reader actually sees.
    expect(loadMoreButton()?.textContent).toBe("Loading…");

    await act(async () => {
      for (const p of pendingFeeds) p.resolve();
    });
    expect(loadMoreButton()?.disabled).toBe(false);
    expect(rows()).toHaveLength(3);
  });

  it("does not append one profile's page onto another profile's feed", async () => {
    // The same guard the mark-seen path already had, on the paging path: a
    // page requested for person-a that lands after the reader switched must
    // not be painted onto person-b's list.
    feedByPerson.set("person-b", feedOf([unseenEvent("20", { itemTitle: "B's item" })]));
    pagesBySince.set("11", feedOf([unseenEvent("12")]));
    await mountSince();

    holdFeeds = true;
    await act(async () => {
      loadMoreButton()?.click();
    });

    activeProfileId = "person-b";
    holdFeeds = false;
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(SinceLastVisit)));
    });

    // person-a's continuation now lands, after the switch.
    await act(async () => {
      for (const p of pendingFeeds) p.resolve();
    });

    expect(rowFor("20")).toBeDefined();
    expect(rowFor("12")).toBeUndefined();
    expect(rowFor("10")).toBeUndefined();
  });

  it("offers no pager on an empty feed, which has no position to continue from", async () => {
    feedByPerson.set("person-a", feedOf([]));
    await mountSince();

    expect(loadMoreButton()).toBeUndefined();
  });
});
