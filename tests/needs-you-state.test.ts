// src/lib/needs-you/state.ts — the inbox's three-state assembly: which
// `blocked`/`in_review`/`plan_review` rows are actually admitted, and how a
// caught fetch failure turns into a message.
import { describe, expect, it } from "vitest";
import { fetchNeedsYou, needsYouErrorMessageFrom } from "@/lib/needs-you/state";

/** One `items` row shaped as `GET /api/items?full=true` returns it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-a",
    title: "Item A",
    headline: null,
    state: "blocked",
    blockedReason: null,
    blockedOnType: null,
    blockedOnPersonId: null,
    mergeAuthority: "agent_judgement",
    updatedAt: "2026-08-18T10:00:00.000Z",
    ...overrides,
  };
}

/** Routes a stub fetch by the `state=` query param, so each of the three reads can answer independently. */
function fetchByState(byState: Record<string, unknown[]>): typeof fetch {
  return (async (url: string) => {
    const parsed = new URL(url, "http://localhost");
    const state = parsed.searchParams.get("state") ?? "";
    return {
      ok: true,
      status: 200,
      json: async () => ({ items: byState[state] ?? [] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("fetchNeedsYou", () => {
  it("returns nothing at all with no active profile — never issues a request for a stranger's queue", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const result = await fetchNeedsYou(null, fetchImpl);
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it("admits a blocked item only when blocked on this person specifically", async () => {
    const fetchImpl = fetchByState({
      blocked: [
        row({ id: "on-me", blockedOnType: "person", blockedOnPersonId: "me" }),
        row({ id: "on-someone-else", blockedOnType: "person", blockedOnPersonId: "someone-else" }),
        row({ id: "external", blockedOnType: "external_process", blockedOnPersonId: null }),
        row({ id: "time", blockedOnType: "time", blockedOnPersonId: null }),
      ],
    });
    const result = await fetchNeedsYou("me", fetchImpl);
    expect(result.map((item) => item.id)).toEqual(["on-me"]);
    expect(result[0]?.reason).toBe("blocked_on_you");
  });

  it("admits an in_review item only when its merge_authority is needs_approval", async () => {
    const fetchImpl = fetchByState({
      in_review: [
        row({ id: "needs-approval", state: "in_review", mergeAuthority: "needs_approval" }),
        row({ id: "pre-approved", state: "in_review", mergeAuthority: "pre_approved" }),
        row({ id: "agent-judgement", state: "in_review", mergeAuthority: "agent_judgement" }),
      ],
    });
    const result = await fetchNeedsYou("me", fetchImpl);
    expect(result.map((item) => item.id)).toEqual(["needs-approval"]);
    expect(result[0]?.reason).toBe("needs_approval");
  });

  it("admits every plan_review item outright, with no further narrowing", async () => {
    const fetchImpl = fetchByState({
      plan_review: [row({ id: "plan-a", state: "plan_review" })],
    });
    const result = await fetchNeedsYou("me", fetchImpl);
    expect(result.map((item) => item.id)).toEqual(["plan-a"]);
    expect(result[0]?.reason).toBe("plan_review");
  });

  it("combines all three sources into one set", async () => {
    const fetchImpl = fetchByState({
      blocked: [row({ id: "blocked-a", blockedOnType: "person", blockedOnPersonId: "me" })],
      in_review: [row({ id: "review-a", state: "in_review", mergeAuthority: "needs_approval" })],
      plan_review: [row({ id: "plan-a", state: "plan_review" })],
    });
    const result = await fetchNeedsYou("me", fetchImpl);
    expect(result.map((item) => item.id).sort()).toEqual(["blocked-a", "plan-a", "review-a"]);
  });

  it("throws a message naming the failing call when a read fails", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchNeedsYou("me", fetchImpl)).rejects.toThrow(/GET \/api\/items returned 500/);
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
