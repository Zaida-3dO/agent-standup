// Performing an undo — the network half.
//
// Driven with a stub `fetch`, so the whole shaping-and-refusal path runs
// without a server. The two properties this file exists to prove:
//
//   1. **Every request carries `expectedFrom`.** Sending an undo without
//      the precondition silently clobbers whatever another session did in
//      the meantime, and the request would otherwise look completely
//      normal — same URL, same method, same `to`. Only an assertion on the
//      body catches its absence.
//   2. **A 409 is surfaced, not retried and not swallowed.** Asserted as
//      both a distinct outcome kind AND a call count, because a retry loop
//      would still end up reporting a failure while having sent the
//      clobbering request.
import { describe, expect, it } from "vitest";
import { runUndo, staleMessage } from "@/lib/undo";
import type { UndoPlan } from "@/lib/undo";

interface StubCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: Record<string, unknown> | undefined;
}

/** A `fetch` answering each call from a queue of responses, recording every request. */
function stubFetch(
  responses: ReadonlyArray<{ status: number; body?: unknown }>,
): typeof fetch & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  let index = 0;
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined,
    });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return Promise.resolve({
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: () => Promise.resolve(response.body ?? {}),
    } as Response);
  }) as typeof fetch & { calls: StubCall[] };
  impl.calls = calls;
  return impl;
}

const onePlan: UndoPlan = {
  available: true,
  steps: [{ kind: "transition", itemId: "item-1", to: "executing", expectedFrom: "in_review" }],
};

/** The envelope `StaleTransitionError` produces through the items routes. */
const staleBody = {
  error: {
    code: "conflict",
    message: "item-1 is in merged, not in_review. The move was not applied: …",
    details: { itemId: "item-1", expectedFrom: "in_review", currentState: "merged" },
  },
};

describe("every undo request carries its precondition", () => {
  it("sends expectedFrom alongside to", async () => {
    const fetchImpl = stubFetch([{ status: 200, body: { item: {} } }]);
    await runUndo(onePlan, fetchImpl);

    expect(fetchImpl.calls).toHaveLength(1);
    const call = fetchImpl.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("/api/ui/items/item-1/transition");
    // Both fields, asserted individually. `to` alone passing is exactly the
    // silent-clobber bug: the request succeeds and looks right.
    expect(call.body?.to).toBe("executing");
    expect(call.body?.expectedFrom).toBe("in_review");
  });

  it("sends the precondition for every step of a bulk undo", async () => {
    const fetchImpl = stubFetch([{ status: 200 }, { status: 200 }]);
    await runUndo(
      {
        available: true,
        steps: [
          { kind: "transition", itemId: "item-1", to: "executing", expectedFrom: "in_review" },
          { kind: "transition", itemId: "item-2", to: "on_deck", expectedFrom: "in_review" },
        ],
      },
      fetchImpl,
    );

    expect(fetchImpl.calls).toHaveLength(2);
    // Not just "present on the first one" — a loop that built the body
    // outside itself would pass a check on call zero alone.
    expect(fetchImpl.calls.map((call) => call.body?.expectedFrom)).toEqual([
      "in_review",
      "in_review",
    ]);
    expect(fetchImpl.calls.map((call) => call.body?.to)).toEqual(["executing", "on_deck"]);
  });
});

describe("a 409 is surfaced, never retried", () => {
  it("reports staleness as its own outcome, naming where the item now is", async () => {
    const fetchImpl = stubFetch([{ status: 409, body: staleBody }]);
    const outcome = await runUndo(onePlan, fetchImpl);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The kind is distinct from an ordinary failure, which is what stops a
    // surface offering a retry on the one outcome where retrying is wrong.
    // Thrown rather than returned on a mismatch, so a `failed` outcome
    // fails this test instead of quietly skipping the assertions below it.
    if (outcome.kind !== "stale") throw new Error(`expected a stale outcome, got ${outcome.kind}`);
    expect(outcome.currentState).toBe("merged");
    expect(outcome.message).toContain("Someone else moved this");
    // The actual current state reaches the person, so the message is
    // checkable rather than a shrug.
    expect(outcome.message).toContain("merged");
  });

  it("sends exactly one request — it does not retry", async () => {
    const fetchImpl = stubFetch([{ status: 409, body: staleBody }]);
    await runUndo(onePlan, fetchImpl);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("stops a bulk undo at the first stale item", async () => {
    // Continuing past a refusal would report "someone else moved this"
    // while having gone on to move the rest anyway — a message that reads
    // as a failure and behaves as a success.
    const fetchImpl = stubFetch([{ status: 409, body: staleBody }, { status: 200 }]);
    const outcome = await runUndo(
      {
        available: true,
        steps: [
          { kind: "transition", itemId: "item-1", to: "executing", expectedFrom: "in_review" },
          { kind: "transition", itemId: "item-2", to: "on_deck", expectedFrom: "in_review" },
        ],
      },
      fetchImpl,
    );

    expect(outcome.ok).toBe(false);
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]!.body?.["itemId"]).toBeUndefined();
    expect(fetchImpl.calls.map((call) => call.url)).toEqual(["/api/ui/items/item-1/transition"]);
  });

  it("does not put an empty state into the sentence", async () => {
    // A conflict whose `currentState` is present but blank must fall back
    // to the shorter message rather than rendering "it is now in , so the
    // undo was not applied." The blank is treated as "the server did not
    // say", which is what it amounts to.
    const fetchImpl = stubFetch([
      {
        status: 409,
        body: { error: { message: "conflict", details: { currentState: "" } } },
      },
    ]);
    const outcome = await runUndo(onePlan, fetchImpl);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    if (outcome.kind !== "stale") throw new Error(`expected a stale outcome, got ${outcome.kind}`);
    expect(outcome.currentState).toBeNull();
    expect(outcome.message).not.toContain("it is now in");
    expect(outcome.message).toContain("Someone else moved this");
  });

  it("does not report a non-conflict failure as staleness", async () => {
    // A 422 guard rejection is a different thing and must not claim
    // someone else moved the item.
    const fetchImpl = stubFetch([
      { status: 422, body: { error: { message: "A guard refused the move." } } },
    ]);
    const outcome = await runUndo(onePlan, fetchImpl);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("failed");
    expect(outcome.message).toBe("A guard refused the move.");
  });
});

describe("staleMessage", () => {
  it("names the current state when the server gave one", () => {
    expect(staleMessage("merged")).toBe(
      "Someone else moved this — it is now in merged, so the undo was not applied.",
    );
  });

  it("still says the undo did not happen when it did not", () => {
    // The fact the person most needs is that nothing was applied; the
    // state is an extra, not the message's reason for existing.
    expect(staleMessage(null)).toContain("the undo was not applied");
    expect(staleMessage(null)).not.toContain("it is now in");
  });
});

describe("the unhappy paths", () => {
  it("reports a request that never reached the server as a failure, not staleness", async () => {
    const offline = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const outcome = await runUndo(onePlan, offline);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Nothing is known about where the item is, so claiming someone else
    // moved it would be a guess.
    expect(outcome.kind).toBe("failed");
  });

  it("falls back to the status when the error body is not readable", async () => {
    const impl = (() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response)) as unknown as typeof fetch;
    const outcome = await runUndo(onePlan, impl);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain("500");
  });

  it("refuses an unavailable plan without sending anything", async () => {
    const fetchImpl = stubFetch([{ status: 200 }]);
    const outcome = await runUndo(
      { available: false, reason: "Archiving cannot be undone." },
      fetchImpl,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toBe("Archiving cannot be undone.");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("succeeds when every step succeeds", async () => {
    const fetchImpl = stubFetch([{ status: 200 }, { status: 200 }]);
    const outcome = await runUndo(
      {
        available: true,
        steps: [
          { kind: "transition", itemId: "item-1", to: "executing", expectedFrom: "in_review" },
          { kind: "transition", itemId: "item-2", to: "on_deck", expectedFrom: "in_review" },
        ],
      },
      fetchImpl,
    );
    expect(outcome.ok).toBe(true);
    expect(fetchImpl.calls).toHaveLength(2);
  });
});
