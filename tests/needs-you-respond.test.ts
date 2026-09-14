// src/lib/needs-you/respond.ts — the four respond-in-place actions.
//
// The load-bearing assertions here are about WHICH ROW EACH ACTION WRITES,
// because that is the whole correctness question: a `needs_approval` row
// approved with the wrong artifact kind satisfies no guard, leaves the item
// held, and credits a human with a review an agent performed. Every
// `toMatchObject` on `kind` below fails on a one-token change to
// `DECISION_BY_REASON`, which is exactly the regression this file exists to
// catch.
import { describe, expect, it } from "vitest";
import {
  answer,
  approve,
  grantStandingApproval,
  reject,
  RESPONSE_KIND_BY_REASON,
} from "@/lib/needs-you/respond";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** A stub fetch that records every call and answers according to `responses`, keyed by URL suffix. */
function stubFetch(responses: Record<string, { ok: boolean; status?: number; body?: unknown }>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    calls.push({ url, method: init?.method ?? "GET", body });
    const match = Object.entries(responses).find(([suffix]) => url.endsWith(suffix));
    const outcome = match?.[1] ?? { ok: true };
    return {
      ok: outcome.ok,
      status: outcome.status ?? (outcome.ok ? 200 : 500),
      json: async () => outcome.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const TIP = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

describe("approve — needs_approval", () => {
  it("records a merge_approval naming the tip commit, NOT a code_review", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      "/artifacts": { ok: true },
      "/transition": { ok: true },
    });

    const result = await approve(
      {
        itemId: "item-b",
        reason: "needs_approval",
        personId: "ope",
        expectedFrom: "in_review",
        tipCommitSha: TIP,
      },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true });
    // The one assertion this whole module exists for. `merge.requires_authorisation`
    // is satisfied only by `kind = 'merge_approval' AND createdByType = 'person'`
    // at the tip; a `code_review` here — which is what this code used to write —
    // satisfies nothing and leaves the item held.
    expect(calls[0]?.body).toMatchObject({
      kind: "merge_approval",
      createdByType: "person",
      createdById: "ope",
      commitSha: TIP,
    });
    expect(calls[0]?.body.kind).not.toBe("code_review");
  });

  it("records no verdict — a merge_approval is not a review and record_artifact refuses one", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      "/artifacts": { ok: true },
      "/transition": { ok: true },
    });

    await approve(
      {
        itemId: "item-b",
        reason: "needs_approval",
        personId: "ope",
        expectedFrom: "in_review",
        tipCommitSha: TIP,
      },
      fetchImpl,
    );

    expect(calls[0]?.body).not.toHaveProperty("verdict");
  });

  it("transitions to merged with the pre-move state as expectedFrom", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      "/artifacts": { ok: true },
      "/transition": { ok: true },
    });

    await approve(
      {
        itemId: "item-b",
        reason: "needs_approval",
        personId: "ope",
        expectedFrom: "in_review",
        tipCommitSha: TIP,
      },
      fetchImpl,
    );

    expect(calls[1]?.body).toEqual({ to: "merged", expectedFrom: "in_review" });
  });

  it("refuses before any request when the item has no commit to pin to", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({});

    const result = await approve(
      {
        itemId: "item-b",
        reason: "needs_approval",
        personId: "ope",
        expectedFrom: "in_review",
        tipCommitSha: null,
      },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    // Nothing was sent: an unpinned merge_approval is refused server-side,
    // so firing it would be a guaranteed round trip to a 422.
    expect(calls).toHaveLength(0);
  });
});

describe("approve — plan_review", () => {
  it("records an approving plan_review and transitions to executing", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({
      "/artifacts": { ok: true },
      "/transition": { ok: true },
    });

    const result = await approve(
      {
        itemId: "item-a",
        reason: "plan_review",
        personId: "ope",
        expectedFrom: "plan_review",
        tipCommitSha: null,
      },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.body).toMatchObject({
      kind: "plan_review",
      verdict: "lgtm",
      createdByType: "person",
      createdById: "ope",
    });
    expect(calls[1]?.body).toEqual({ to: "executing", expectedFrom: "plan_review" });
  });

  it("does not pin a commit — a plan is approved as a plan, not against code", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ "/artifacts": { ok: true } });

    await approve(
      {
        itemId: "item-a",
        reason: "plan_review",
        personId: "ope",
        expectedFrom: "plan_review",
        tipCommitSha: TIP,
      },
      fetchImpl,
    );

    expect(calls[0]?.body).not.toHaveProperty("commitSha");
  });
});

describe("approve — needs_visual_review", () => {
  it("records an approving visual_review at the tip and does NOT transition", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ "/artifacts": { ok: true } });

    const result = await approve(
      {
        itemId: "item-c",
        reason: "needs_visual_review",
        personId: "ope",
        expectedFrom: "in_review",
        tipCommitSha: TIP,
      },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.body).toMatchObject({
      kind: "visual_review",
      verdict: "lgtm",
      createdByType: "person",
      commitSha: TIP,
    });
    // Only the artifact call. A recorded look clears one merge clause; the
    // item may still be held by others, so moving it to `merged` here would
    // assert a merge the other guards never agreed to.
    expect(calls).toHaveLength(1);
  });
});

describe("approve — failure handling", () => {
  it("stops before transitioning when the artifact write is refused", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ "/artifacts": { ok: false, status: 422 } });

    const result = await approve(
      {
        itemId: "item-a",
        reason: "plan_review",
        personId: "ope",
        expectedFrom: "plan_review",
        tipCommitSha: null,
      },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("surfaces the server's own message rather than a generic one", async () => {
    const { fetch: fetchImpl } = stubFetch({
      "/artifacts": {
        ok: false,
        status: 422,
        body: { error: { message: "Only a person can record a merge_approval." } },
      },
    });

    const result = await approve(
      {
        itemId: "item-b",
        reason: "needs_approval",
        personId: "ope",
        expectedFrom: "in_review",
        tipCommitSha: TIP,
      },
      fetchImpl,
    );

    expect(result).toEqual({
      ok: false,
      message: "Only a person can record a merge_approval.",
    });
  });

  it("says the approval landed even when the move did not", async () => {
    const { fetch: fetchImpl } = stubFetch({
      "/artifacts": { ok: true },
      "/transition": { ok: false, status: 409 },
    });

    const result = await approve(
      {
        itemId: "item-b",
        reason: "needs_approval",
        personId: "ope",
        expectedFrom: "in_review",
        tipCommitSha: TIP,
      },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("was recorded");
  });

  it("refuses blocked_on_you — it is waiting on an answer, not a decision", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({});

    const result = await approve(
      {
        itemId: "item-d",
        reason: "blocked_on_you",
        personId: "ope",
        expectedFrom: "blocked",
        tipCommitSha: null,
      },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("reject", () => {
  it("records a rejecting visual_review and never transitions", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ "/artifacts": { ok: true } });

    const result = await reject(
      {
        itemId: "item-c",
        reason: "needs_visual_review",
        personId: "ope",
        expectedFrom: "in_review",
        tipCommitSha: TIP,
      },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      kind: "visual_review",
      verdict: "changes_required",
      createdByType: "person",
    });
  });

  it("refuses needs_approval — an approval is withheld, not refused on the record", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({});

    const result = await reject(
      {
        itemId: "item-b",
        reason: "needs_approval",
        personId: "ope",
        expectedFrom: "in_review",
        tipCommitSha: TIP,
      },
      fetchImpl,
    );

    expect(result.ok).toBe(false);
    // Nothing written. There is no rejecting `merge_approval`, and writing a
    // rejecting `code_review` in a human's name is the exact confusion the
    // approve path was fixed to stop.
    expect(calls).toHaveLength(0);
  });
});

describe("answer", () => {
  it("posts a note attributed to the person, using note's own field names", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ "/notes": { ok: true } });

    const result = await answer(
      { itemId: "item-d", personId: "ope", body: "  Use the second option.  " },
      fetchImpl,
    );

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toContain("/items/item-d/notes");
    // `note`'s schema is `.strict()`: these exact names, or the call is
    // rejected outright rather than silently dropping the attribution.
    expect(calls[0]?.body).toEqual({
      body: "Use the second option.",
      actorType: "person",
      actorId: "ope",
    });
  });

  it("refuses an empty reply without a request", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({});

    const result = await answer({ itemId: "item-d", personId: "ope", body: "   " }, fetchImpl);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("grantStandingApproval", () => {
  it("PATCHes mergeAuthority to the hyphenated pre-approved the API accepts", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ "/items/item-b": { ok: true } });

    const result = await grantStandingApproval({ itemId: "item-b" }, fetchImpl);

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.method).toBe("PATCH");
    // `update_item` accepts `pre-approved`; the DB enum's `pre_approved`
    // would be refused, so the spelling is load-bearing.
    expect(calls[0]?.body).toEqual({ mergeAuthority: "pre-approved" });
  });

  it("records no artifact — a standing grant is not a decision about a commit", async () => {
    const { fetch: fetchImpl, calls } = stubFetch({ "/items/item-b": { ok: true } });

    await grantStandingApproval({ itemId: "item-b" }, fetchImpl);

    expect(calls.some((call) => call.url.endsWith("/artifacts"))).toBe(false);
  });
});

describe("RESPONSE_KIND_BY_REASON", () => {
  it("gives every reason a control, and only blocked_on_you an answer box", () => {
    expect(RESPONSE_KIND_BY_REASON).toEqual({
      blocked_on_you: "answer",
      needs_approval: "decision",
      needs_visual_review: "decision",
      plan_review: "decision",
    });
  });
});
