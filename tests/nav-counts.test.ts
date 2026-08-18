// `src/lib/nav/counts.ts` — the two live numbers the sidebar shows.
//
// The claim being tested is that they are FETCHED, not constants: a
// hardcoded badge is not a placeholder, it is a lie that looks exactly
// like a working feature. Every test here therefore controls the response
// and asserts the number came out of it.
import { describe, expect, it } from "vitest";
import {
  countForBadge,
  emptyCounts,
  fetchNavCounts,
  fetchNeedsYouCount,
  fetchUnseenCount,
} from "@/lib/nav/counts";
import type { BoardEntry } from "@/lib/board/types";

function entry(overrides: Partial<BoardEntry["item"]> = {}): BoardEntry {
  return {
    item: {
      id: "i1",
      title: "t",
      headline: null,
      kind: "task",
      state: "blocked",
      priority: "P2",
      area: "a",
      repo: null,
      blockedOnPersonId: "me",
      blockedOnType: "person",
      blockedReason: null,
      pauseReason: null,
      ...overrides,
    },
    column: "waiting",
    assignments: [],
  };
}

/** A `fetch` that answers every request with one JSON body, recording the urls it saw. */
function stubFetch(body: unknown, urls: string[] = []): typeof fetch {
  return ((url: string) => {
    urls.push(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
  }) as unknown as typeof fetch;
}

function boardBody(entries: readonly BoardEntry[]) {
  return {
    board: {
      columns: { waiting: { entries, total: entries.length, nextCursor: null, withheld: false } },
    },
  };
}

describe("fetchNeedsYouCount", () => {
  it("counts only items blocked on the given person", async () => {
    const count = await fetchNeedsYouCount(
      "me",
      stubFetch(
        boardBody([
          entry(),
          entry({ id: "i2" }),
          // Someone else's queue, not yours.
          entry({ id: "i3", blockedOnPersonId: "them" }),
          // Blocked on a deploy — nothing you can do.
          entry({ id: "i4", blockedOnType: "external_process" }),
          // Paused means nobody is on it, not that you are.
          entry({ id: "i5", state: "paused" }),
        ]),
      ),
    );
    // Changing `needsYou`'s person comparison from `===` to `!==` flips
    // this from 2 to 2 of the others — either way it fails.
    expect(count).toBe(2);
  });

  it("issues NO request at all when nobody is signed in", async () => {
    const urls: string[] = [];
    const count = await fetchNeedsYouCount(null, stubFetch(boardBody([entry()]), urls));
    // Nothing can need you when the app does not know who you are, and
    // issuing the read anyway would show a stranger's queue.
    expect(count).toBe(0);
    expect(urls).toEqual([]);
  });

  it("reads the waiting column only — not all four", async () => {
    const urls: string[] = [];
    await fetchNeedsYouCount("me", stubFetch(boardBody([]), urls));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("column=waiting");
  });
});

describe("fetchUnseenCount", () => {
  it("returns the server's own unseen total, not the number of events returned", async () => {
    const urls: string[] = [];
    const count = await fetchUnseenCount(
      "me",
      // One event in the page, forty-two unseen overall. Reading
      // `events.length` instead of `unseenCount` gives 1 and fails.
      stubFetch(
        { events: [{ id: "1" }], cursor: "", horizon: "", unseenCount: 42, firstVisit: false },
        urls,
      ),
    );
    expect(count).toBe(42);
    // …and asks for one event, because the count does not depend on how
    // many come back and a badge should not pull a page of event bodies.
    expect(urls[0]).toContain("limit=1");
  });

  it("asks for the given profile's read state", async () => {
    const urls: string[] = [];
    await fetchUnseenCount("me", stubFetch({ unseenCount: 0 }, urls));
    expect(urls[0]).toContain("personId=me");
  });
});

describe("fetchNavCounts", () => {
  it("returns both numbers together", async () => {
    const fetchImpl = ((url: string) => {
      const body = url.startsWith("/api/ui/events")
        ? { events: [], cursor: "", horizon: "", unseenCount: 5, firstVisit: false }
        : boardBody([entry(), entry({ id: "i2" }), entry({ id: "i3", blockedOnPersonId: "them" })]);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
    }) as unknown as typeof fetch;
    expect(await fetchNavCounts("me", fetchImpl)).toEqual({ unseen: 5, needsYou: 2 });
  });

  it("degrades a failed read to zero rather than rejecting, one side at a time", async () => {
    // The sidebar is chrome on every page: a rejected badge fetch that
    // propagated would take navigation down on a screen whose own content
    // loaded fine, to report that a number is unavailable. Zero renders as
    // no badge, which is honest — it is not a badge showing a wrong number.
    const fetchImpl = ((url: string) => {
      if (url.startsWith("/api/ui/events")) return Promise.reject(new Error("events down"));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(boardBody([entry()])),
      } as Response);
    }) as unknown as typeof fetch;
    // Removing either `.catch(() => 0)` in `fetchNavCounts` makes this
    // reject instead of resolving.
    expect(await fetchNavCounts("me", fetchImpl)).toEqual({ unseen: 0, needsYou: 1 });
  });

  it("degrades to zeroes when both reads fail", async () => {
    const fetchImpl = (() => Promise.reject(new Error("all down"))) as unknown as typeof fetch;
    expect(await fetchNavCounts("me", fetchImpl)).toEqual(emptyCounts());
  });
});

describe("countForBadge", () => {
  it("maps each badge kind to its own number", () => {
    const counts = { unseen: 3, needsYou: 7 };
    // Swapping the two branches makes both of these fail.
    expect(countForBadge("unseen", counts)).toBe(3);
    expect(countForBadge("needsYou", counts)).toBe(7);
  });

  it("returns null for a destination that carries no badge", () => {
    expect(countForBadge(undefined, { unseen: 3, needsYou: 7 })).toBeNull();
  });
});
