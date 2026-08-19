// src/lib/needs-you/decide.ts — the approve/deny composition over
// `record_artifact` + `transition_item`: which kind and verdict each reason
// writes, that a failed artifact write stops before the transition, and
// that deny never transitions at all.
import { describe, expect, it } from "vitest";
import { approve, deny } from "@/lib/needs-you/decide";

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A stub fetch that records every call and answers according to `responses`, keyed by URL suffix. */
function stubFetch(responses: Record<string, { ok: boolean; status?: number }>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const match = Object.entries(responses).find(([suffix]) => url.endsWith(suffix));
    const outcome = match?.[1] ?? { ok: true };
    return {
      ok: outcome.ok,
      status: outcome.status ?? (outcome.ok ? 200 : 500),
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe("approve", () => {
  it("records an approving plan_review artifact and transitions to executing", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      "/artifacts": { ok: true },
      "/transition": { ok: true },
    });
    const result = await approve(
      { itemId: "item-a", reason: "plan_review", personId: "me" },
      fetchImpl,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain("/items/item-a/artifacts");
    expect(calls[0]?.body).toMatchObject({
      kind: "plan_review",
      verdict: "lgtm",
      createdByType: "person",
      createdById: "me",
    });
    expect(calls[1]?.url).toContain("/items/item-a/transition");
    expect(calls[1]?.body).toEqual({ to: "executing" });
  });

  it("records an approving code_review artifact and transitions to merged for needs_approval", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      "/artifacts": { ok: true },
      "/transition": { ok: true },
    });
    await approve({ itemId: "item-b", reason: "needs_approval", personId: "me" }, fetchImpl);
    expect(calls[0]?.body).toMatchObject({ kind: "code_review", verdict: "lgtm" });
    expect(calls[1]?.body).toEqual({ to: "merged" });
  });

  it("stops before transitioning when the artifact write is refused", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      "/artifacts": { ok: false, status: 422 },
    });
    const result = await approve(
      { itemId: "item-a", reason: "plan_review", personId: "me" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    // Only the artifact call was made — no transition attempt with no
    // evidence behind it.
    expect(calls).toHaveLength(1);
  });

  it("refuses blocked_on_you outright — it has no single approval transition", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({});
    const result = await approve(
      { itemId: "item-a", reason: "blocked_on_you", personId: "me" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("deny", () => {
  it("records a changes_required verdict and makes no transition call", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ "/artifacts": { ok: true } });
    const result = await deny(
      { itemId: "item-a", reason: "needs_approval", personId: "me" },
      fetchImpl,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ kind: "code_review", verdict: "changes_required" });
  });

  it("surfaces a server refusal as a failure", async () => {
    const { fetch: fetchImpl } = stubFetch({ "/artifacts": { ok: false, status: 500 } });
    const result = await deny(
      { itemId: "item-a", reason: "plan_review", personId: "me" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
  });
});
