// src/lib/since/state.ts — the "since your last visit" load lifecycle for
// MILESTONES.md #38: what the query string becomes, what `GET /api/events`
// turns into, what a failure turns into, and what marking something seen
// does to the feed in hand.
import { describe, expect, it } from "vitest";
import {
  applySeen,
  buildFeedQuery,
  fetchFeed,
  markManySeen,
  markSeen,
  sinceErrorMessageFrom,
} from "@/lib/since/state";
import { emptyFeed } from "@/lib/since/view";
import type { SinceEvent, SinceFeed } from "@/lib/since/types";

/** A minimal stand-in for `fetch` — no network, no DOM. */
function fetchReturning(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

/** Records every call made to it, and answers 200. */
function recordingFetch(status = 200): {
  fetch: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function event(overrides: Partial<SinceEvent> = {}): SinceEvent {
  return {
    id: "1",
    itemId: "item-a",
    itemTitle: "Item A",
    ts: "2026-08-14T10:00:00.000Z",
    actorType: "agent",
    actorId: "builder-one",
    type: "note",
    payload: {},
    body: null,
    seen: false,
    seenByAnyone: false,
    ...overrides,
  };
}

function feed(overrides: Partial<SinceFeed> = {}): SinceFeed {
  return { ...emptyFeed(), ...overrides };
}

describe("buildFeedQuery", () => {
  it("asks for the bare endpoint when nothing is specified", () => {
    expect(buildFeedQuery()).toBe("/api/ui/events");
    expect(buildFeedQuery({})).toBe("/api/ui/events");
  });

  it("carries the profile whose read state is wanted", () => {
    expect(buildFeedQuery({ personId: "user-a" })).toBe("/api/ui/events?personId=user-a");
  });

  it("omits personId entirely when no profile is chosen", () => {
    // `?personId=` would be an invalid_input rejection, where "nobody is
    // signed in" is a legal read that returns everything unseen.
    expect(buildFeedQuery({ personId: null })).toBe("/api/ui/events");
    expect(buildFeedQuery({ personId: undefined })).toBe("/api/ui/events");
  });

  it("omits unseenOnly when false rather than spelling out the default", () => {
    expect(buildFeedQuery({ unseenOnly: false })).toBe("/api/ui/events");
    expect(buildFeedQuery({ unseenOnly: true })).toBe("/api/ui/events?unseenOnly=true");
  });

  it("carries the cursor and the page size when given", () => {
    expect(buildFeedQuery({ since: "42", limit: 10 })).toBe("/api/ui/events?since=42&limit=10");
  });

  it("sends since=0 rather than dropping it — zero is a real cursor, not an absence", () => {
    expect(buildFeedQuery({ since: "0" })).toBe("/api/ui/events?since=0");
  });

  it("escapes a profile id that would otherwise break the query string", () => {
    expect(buildFeedQuery({ personId: "a&b=c" })).toBe("/api/ui/events?personId=a%26b%3Dc");
  });
});

describe("fetchFeed", () => {
  it("returns the feed the API sent", async () => {
    const result = await fetchFeed(
      {},
      fetchReturning(200, {
        events: [{ id: "7", seen: false }],
        cursor: "7",
        horizon: "99",
        unseenCount: 1,
        firstVisit: false,
      }),
    );
    expect(result.events).toHaveLength(1);
    expect(result.cursor).toBe("7");
    expect(result.unseenCount).toBe(1);
  });

  it("requests the URL the query builder produced", async () => {
    const recorder = recordingFetch();
    await fetchFeed({ personId: "user-a", unseenOnly: true }, recorder.fetch);
    expect(recorder.calls[0]!.url).toBe("/api/ui/events?personId=user-a&unseenOnly=true");
  });

  it("fills in any field the response omitted, so a component never maps undefined", async () => {
    const result = await fetchFeed({}, fetchReturning(200, { cursor: "5" }));
    expect(Array.isArray(result.events)).toBe(true);
    expect(result.unseenCount).toBe(0);
    expect(result.cursor).toBe("5");
  });

  it("tolerates a null body", async () => {
    const result = await fetchFeed({}, fetchReturning(200, null));
    expect(result.events).toEqual([]);
  });

  it("throws a message naming the status, not a raw Response", async () => {
    await expect(fetchFeed({}, fetchReturning(500, {}))).rejects.toThrow(
      "GET /api/events returned 500",
    );
  });

  it("throws on a 404 too, rather than treating it as an empty feed", async () => {
    await expect(fetchFeed({}, fetchReturning(404, {}))).rejects.toThrow("returned 404");
  });
});

describe("markSeen", () => {
  it("posts to the event's own seen endpoint with the profile in the body", async () => {
    const recorder = recordingFetch();
    await markSeen("42", "user-a", recorder.fetch);
    const call = recorder.calls[0]!;
    expect(call.url).toBe("/api/ui/events/42/seen");
    expect(call.init?.method).toBe("POST");
    expect(JSON.parse(String(call.init?.body))).toEqual({ personId: "user-a" });
  });

  it("escapes an event id rather than injecting it raw into the path", async () => {
    const recorder = recordingFetch();
    await markSeen("a/b", "user-a", recorder.fetch);
    expect(recorder.calls[0]!.url).toBe("/api/ui/events/a%2Fb/seen");
  });

  it("throws a message naming the status when the write fails", async () => {
    const recorder = recordingFetch(500);
    await expect(markSeen("1", "user-a", recorder.fetch)).rejects.toThrow("returned 500");
  });
});

describe("markManySeen", () => {
  it("sends one request per event", async () => {
    const recorder = recordingFetch();
    await markManySeen(["1", "2", "3"], "user-a", recorder.fetch);
    expect(recorder.calls.map((c) => c.url)).toEqual([
      "/api/ui/events/1/seen",
      "/api/ui/events/2/seen",
      "/api/ui/events/3/seen",
    ]);
  });

  it("sends nothing at all for an empty list", async () => {
    const recorder = recordingFetch();
    await markManySeen([], "user-a", recorder.fetch);
    expect(recorder.calls).toHaveLength(0);
  });

  it("stops at the first failure rather than pressing on", async () => {
    // The ones that landed stay landed; a retry re-sends only what is still
    // unseen, so partial progress converges rather than duplicating.
    let count = 0;
    const impl = (async () => {
      count++;
      return { ok: count < 2, status: count < 2 ? 200 : 500 } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(markManySeen(["1", "2", "3"], "user-a", impl)).rejects.toThrow("returned 500");
    expect(count).toBe(2);
  });
});

describe("applySeen — the local update, and its idempotence", () => {
  it("marks the named event seen and recounts", () => {
    const before = feed({
      events: [event({ id: "1" }), event({ id: "2" })],
      unseenCount: 2,
    });
    const after = applySeen(before, ["1"]);
    expect(after.events[0]!.seen).toBe(true);
    expect(after.events[1]!.seen).toBe(false);
    expect(after.unseenCount).toBe(1);
  });

  it("is idempotent — applying the same id twice leaves the count where it was", () => {
    // The count is recomputed from the events rather than decremented, so a
    // repeat cannot drive it below the truth. This mirrors the server's own
    // ON CONFLICT DO NOTHING.
    const before = feed({ events: [event({ id: "1" })], unseenCount: 1 });
    const once = applySeen(before, ["1"]);
    const twice = applySeen(once, ["1"]);
    expect(once.unseenCount).toBe(0);
    expect(twice.unseenCount).toBe(0);
    expect(twice.events[0]!.seen).toBe(true);
  });

  it("never drives the count negative when told to mark an already-seen event", () => {
    const before = feed({ events: [event({ id: "1", seen: true })], unseenCount: 0 });
    expect(applySeen(before, ["1"]).unseenCount).toBe(0);
  });

  it("does not mutate the feed it was given", () => {
    const before = feed({ events: [event({ id: "1" })], unseenCount: 1 });
    applySeen(before, ["1"]);
    expect(before.events[0]!.seen).toBe(false);
    expect(before.unseenCount).toBe(1);
  });

  it("ignores an id that is not in the feed", () => {
    const before = feed({ events: [event({ id: "1" })], unseenCount: 1 });
    const after = applySeen(before, ["999"]);
    expect(after.unseenCount).toBe(1);
    expect(after.events[0]!.seen).toBe(false);
  });

  it("marks every id in a mark-all", () => {
    const before = feed({
      events: [event({ id: "1" }), event({ id: "2" }), event({ id: "3" })],
      unseenCount: 3,
    });
    const after = applySeen(before, ["1", "2", "3"]);
    expect(after.unseenCount).toBe(0);
    expect(after.events.every((e) => e.seen)).toBe(true);
  });

  it("clears firstVisit once anything has been marked", () => {
    // A profile that has just marked something seen now HAS read state.
    // Leaving this true would make the empty state say "nothing has
    // happened yet" the moment someone cleared a full list.
    const before = feed({ events: [event({ id: "1" })], unseenCount: 1, firstVisit: true });
    expect(applySeen(before, ["1"]).firstVisit).toBe(false);
  });

  it("leaves firstVisit alone when nothing was marked", () => {
    const before = feed({ firstVisit: true });
    expect(applySeen(before, []).firstVisit).toBe(true);
  });

  it("sets seenByAnyone when you are the one who saw it", () => {
    const before = feed({ events: [event({ id: "1", seenByAnyone: false })], unseenCount: 1 });
    expect(applySeen(before, ["1"]).events[0]!.seenByAnyone).toBe(true);
  });
});

describe("sinceErrorMessageFrom", () => {
  it("uses an Error's own message", () => {
    expect(sinceErrorMessageFrom(new Error("the API said no"))).toBe("the API said no");
  });

  it("never leaks a raw non-Error into the UI", () => {
    expect(sinceErrorMessageFrom({ weird: true })).toBe("Could not load what's new.");
    expect(sinceErrorMessageFrom("a string")).toBe("Could not load what's new.");
    expect(sinceErrorMessageFrom(null)).toBe("Could not load what's new.");
  });
});
