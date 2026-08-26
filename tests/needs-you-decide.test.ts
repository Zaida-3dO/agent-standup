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
      { itemId: "item-a", reason: "plan_review", personId: "me", expectedFrom: "plan_review" },
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
    expect(calls[1]?.body).toEqual({ to: "executing", expectedFrom: "plan_review" });
  });

  it("records an approving code_review artifact and transitions to merged for needs_approval", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      "/artifacts": { ok: true },
      "/transition": { ok: true },
    });
    await approve(
      { itemId: "item-b", reason: "needs_approval", personId: "me", expectedFrom: "in_review" },
      fetchImpl,
    );
    expect(calls[0]?.body).toMatchObject({ kind: "code_review", verdict: "lgtm" });
    expect(calls[1]?.body).toEqual({ to: "merged", expectedFrom: "in_review" });
  });

  it("stops before transitioning when the artifact write is refused", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      "/artifacts": { ok: false, status: 422 },
    });
    const result = await approve(
      { itemId: "item-a", reason: "plan_review", personId: "me", expectedFrom: "plan_review" },
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
      { itemId: "item-a", reason: "blocked_on_you", personId: "me", expectedFrom: "blocked" },
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
      { itemId: "item-a", reason: "needs_approval", personId: "me", expectedFrom: "in_review" },
      fetchImpl,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ kind: "code_review", verdict: "changes_required" });
  });

  it("surfaces a server refusal as a failure", async () => {
    const { fetch: fetchImpl } = stubFetch({ "/artifacts": { ok: false, status: 500 } });
    const result = await deny(
      { itemId: "item-a", reason: "plan_review", personId: "me", expectedFrom: "plan_review" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
  });
});

// ── The transition's precondition (#257, as #292 applied it to the board) ──
//
// These do NOT stub a refusal into existence. The stub below holds a real
// `currentState` and answers 409 *only* when the `expectedFrom` it actually
// received disagrees with it — so a request earns its refusal, and a version
// of `approve` that sent no precondition (or sent the target state) would get
// a 200 from this stub and fail these tests. #292 found two conflict tests
// that had been green the whole time the code could only ever receive a 200,
// because their stub keyed off a flag rather than off the request.
describe("approve — the transition states its precondition", () => {
  /** A stub whose transition endpoint behaves like `applyTransition`: it refuses a mismatched, and only a mismatched, `expectedFrom`. */
  function stateAwareFetch(currentState: string): { fetch: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const impl = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
      calls.push({ url, body });
      if (!url.endsWith("/transition")) {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      const expected = body.expectedFrom;
      // No precondition supplied → the server moves it from wherever it is.
      // This is the 200 that #292 calls the silent overwrite.
      if (expected === undefined) {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (expected !== currentState) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: {
              message: `item-a is in ${currentState}, not ${String(expected)}. The move was not applied.`,
            },
          }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetch: impl, calls };
  }

  it("sends the item's pre-move state, which is never the state it is moving to", async () => {
    const { fetch: fetchImpl, calls } = stateAwareFetch("plan_review");
    await approve(
      { itemId: "item-a", reason: "plan_review", personId: "me", expectedFrom: "plan_review" },
      fetchImpl,
    );
    const body = calls[1]?.body;
    // Asserted by value, not by presence: `toHaveProperty` would pass just as
    // happily on `expectedFrom: "executing"` — the target — which would make
    // the precondition compare a state to itself and never fire.
    expect(body?.expectedFrom).toBe("plan_review");
    expect(body?.expectedFrom).not.toBe(body?.to);
  });

  it("is refused when the item has moved since the inbox was loaded", async () => {
    // The row said `plan_review`; the item is now `executing` — someone else
    // approved it while this screen sat open.
    const { fetch: fetchImpl, calls } = stateAwareFetch("executing");
    const result = await approve(
      { itemId: "item-a", reason: "plan_review", personId: "me", expectedFrom: "plan_review" },
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(2);
    // The server's own words reach the person, rather than a generic failure.
    if (!result.ok) expect(result.message).toContain("is in executing");
  });

  it("applies the move when the item is still where the inbox said it was", async () => {
    const { fetch: fetchImpl } = stateAwareFetch("in_review");
    const result = await approve(
      { itemId: "item-b", reason: "needs_approval", personId: "me", expectedFrom: "in_review" },
      fetchImpl,
    );
    expect(result).toEqual({ ok: true });
  });
});
