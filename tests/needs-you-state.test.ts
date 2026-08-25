// src/lib/needs-you/state.ts — the inbox's single read: what it requests,
// what it makes of the response, and how a caught fetch failure turns into
// a message.
//
// **What moved, and why these tests changed shape (T24).** This file used
// to assert the *admission rule* — which `blocked`/`in_review`/`plan_review`
// rows count as needing you — because that rule lived here, applied to the
// results of three separate `list_items` reads. It is now one server-side
// operation (`get_needs_you`), so the rule is tested where it lives, in
// `tests/needs-you-operation.test.ts`, against a real database. Asserting it
// here too would be asserting a stub's behaviour: a client test can only
// check that this module renders back whatever rows it was handed, which
// says nothing about whether the right rows were selected.
//
// What is genuinely this module's job, and is what these cover: issuing
// **one** request rather than three, asking the right question in it,
// trusting the server's `reason` instead of recomputing it, and the two
// count fallbacks.
import { describe, expect, it } from "vitest";
import {
  fetchNeedsYou,
  fetchNeedsYouTotal,
  needsYouErrorMessageFrom,
  NEEDS_YOU_PAGE_SIZE,
} from "@/lib/needs-you/state";

/** One row shaped as `GET /api/needs-you` returns it in the slim shape. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-a",
    title: "Item A",
    headline: null,
    state: "blocked",
    reason: "blocked_on_you",
    blockedReason: null,
    mergeAuthority: "agent_judgement",
    updatedAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

/** A stub fetch that records every URL it was called with and answers with one body. */
function recordingFetch(body: unknown): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("fetchNeedsYou", () => {
  it("returns nothing at all with no active profile — never issues a request for a stranger's queue", async () => {
    const { fetchImpl, urls } = recordingFetch({ items: [row()], total: 1 });
    const result = await fetchNeedsYou(null, fetchImpl);
    expect(result).toEqual({ items: [], total: 0 });
    expect(urls).toEqual([]);
  });

  it("issues exactly ONE request — the whole point of T24, which replaced three", async () => {
    const { fetchImpl, urls } = recordingFetch({ items: [row()], total: 1 });
    await fetchNeedsYou("me", fetchImpl);
    expect(urls).toHaveLength(1);
  });

  it("asks get_needs_you about this person, for one bounded page", async () => {
    const { fetchImpl, urls } = recordingFetch({ items: [], total: 0 });
    await fetchNeedsYou("me", fetchImpl);
    const parsed = new URL(urls[0] ?? "", "http://localhost");
    expect(parsed.pathname).toBe("/api/ui/needs-you");
    expect(parsed.searchParams.get("personId")).toBe("me");
    expect(parsed.searchParams.get("limit")).toBe(String(NEEDS_YOU_PAGE_SIZE));
  });

  it("never asks for full records — the slim shape carries every field a row draws", async () => {
    const { fetchImpl, urls } = recordingFetch({ items: [], total: 0 });
    await fetchNeedsYou("me", fetchImpl);
    expect(new URL(urls[0] ?? "", "http://localhost").searchParams.get("full")).toBeNull();
  });

  it("escapes a person id that would otherwise alter the query string", async () => {
    const { fetchImpl, urls } = recordingFetch({ items: [], total: 0 });
    await fetchNeedsYou("a&limit=999", fetchImpl);
    const parsed = new URL(urls[0] ?? "", "http://localhost");
    expect(parsed.searchParams.get("personId")).toBe("a&limit=999");
    expect(parsed.searchParams.get("limit")).toBe(String(NEEDS_YOU_PAGE_SIZE));
  });

  it("carries every field of a row through, including the server's own reason", async () => {
    const { fetchImpl } = recordingFetch({
      items: [
        row({
          id: "plan-a",
          title: "A plan",
          headline: "waiting on you",
          state: "plan_review",
          reason: "plan_review",
          blockedReason: "needs a decision",
          mergeAuthority: "needs_approval",
          updatedAt: "2026-08-19T09:00:00.000Z",
        }),
      ],
      total: 1,
    });
    const { items } = await fetchNeedsYou("me", fetchImpl);
    expect(items).toEqual([
      {
        id: "plan-a",
        title: "A plan",
        headline: "waiting on you",
        state: "plan_review",
        reason: "plan_review",
        blockedReason: "needs a decision",
        mergeAuthority: "needs_approval",
        updatedAt: "2026-08-19T09:00:00.000Z",
      },
    ]);
  });

  it("takes the reason the server derived rather than recomputing one from the state", async () => {
    // `state` and `reason` deliberately disagree: a client re-deriving the
    // label from `state` would answer `blocked_on_you`, and the whole point
    // of the server-side rule is that it does not.
    const { fetchImpl } = recordingFetch({
      items: [row({ state: "blocked", reason: "needs_approval" })],
      total: 1,
    });
    const { items } = await fetchNeedsYou("me", fetchImpl);
    expect(items[0]?.reason).toBe("needs_approval");
  });

  it("reports the server's total, which can exceed the page it returned", async () => {
    const { fetchImpl } = recordingFetch({ items: [row()], total: 97 });
    const { items, total } = await fetchNeedsYou("me", fetchImpl);
    expect(items).toHaveLength(1);
    expect(total).toBe(97);
  });

  it("falls back to the page's own length when the response carries no total", async () => {
    const { fetchImpl } = recordingFetch({ items: [row({ id: "a" }), row({ id: "b" })] });
    expect((await fetchNeedsYou("me", fetchImpl)).total).toBe(2);
  });

  it("treats a response with no items as an empty inbox rather than failing", async () => {
    const { fetchImpl } = recordingFetch({});
    expect(await fetchNeedsYou("me", fetchImpl)).toEqual({ items: [], total: 0 });
  });

  it("throws a message naming the failing call when the read fails", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchNeedsYou("me", fetchImpl)).rejects.toThrow(
      /GET \/api\/needs-you returned 500/,
    );
  });
});

describe("fetchNeedsYouTotal", () => {
  it("asks for a single row, because only the count is rendered", async () => {
    const { fetchImpl, urls } = recordingFetch({ items: [], total: 12 });
    await fetchNeedsYouTotal("me", fetchImpl);
    expect(new URL(urls[0] ?? "", "http://localhost").searchParams.get("limit")).toBe("1");
  });

  it("returns the server's total, not the number of rows it was sent", async () => {
    // One row back, twelve waiting: a badge counting the rows would say 1.
    const { fetchImpl } = recordingFetch({ items: [row()], total: 12 });
    expect(await fetchNeedsYouTotal("me", fetchImpl)).toBe(12);
  });

  it("reads zero when the response carries no total", async () => {
    const { fetchImpl } = recordingFetch({ items: [] });
    expect(await fetchNeedsYouTotal("me", fetchImpl)).toBe(0);
  });

  it("throws rather than reporting zero when the read fails — a wrong badge is worse than none", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 503,
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchNeedsYouTotal("me", fetchImpl)).rejects.toThrow(
      /GET \/api\/needs-you returned 503/,
    );
  });
});

describe("needsYouErrorMessageFrom", () => {
  it("uses an Error's own message", () => {
    expect(needsYouErrorMessageFrom(new Error("boom"))).toBe("boom");
  });

  it("falls back to a generic message for a non-Error", () => {
    expect(needsYouErrorMessageFrom("boom")).toBe("Could not load what needs you.");
  });
});
