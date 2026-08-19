// src/lib/fleet/state.ts — the fleet page's network calls (M10 T16):
// GET /api/fleet, POST /api/sweep, POST /api/claims/takeover.
//
// Driven with a stub `fetch`, so every path — success, a server refusal,
// and the request never reaching the server at all — is exercised without
// a real server. Each test names the single-character change that would
// break it.
import { describe, expect, it } from "vitest";
import {
  fetchFleet,
  fleetErrorMessageFrom,
  requestTakeover,
  runSweep,
  type TakeoverRequest,
} from "@/lib/fleet/state";

interface StubCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: unknown;
}

function stubFetch(status: number, body: unknown): typeof fetch & { calls: StubCall[] } {
  const calls: StubCall[] = [];
  const impl = ((url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  }) as typeof fetch & { calls: StubCall[] };
  impl.calls = calls;
  return impl;
}

const failingFetch = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;

describe("fetchFleet", () => {
  it("GETs /api/fleet through the UI proxy and returns the assignments", async () => {
    const impl = stubFetch(200, { assignments: [{ id: "a1" }] });
    const result = await fetchFleet(impl);
    expect(impl.calls).toHaveLength(1);
    expect(impl.calls[0]!.url).toBe("/api/ui/fleet");
    expect(result).toEqual([{ id: "a1" }]);
  });

  it("fills in a missing assignments key as an empty array rather than crashing", async () => {
    const impl = stubFetch(200, {});
    const result = await fetchFleet(impl);
    expect(result).toEqual([]);
  });

  it("throws a message naming the failing call on a non-2xx response", async () => {
    const impl = stubFetch(500, {});
    await expect(fetchFleet(impl)).rejects.toThrow(/GET \/api\/fleet returned 500/);
  });
});

describe("fleetErrorMessageFrom", () => {
  it("uses the Error's own message", () => {
    expect(fleetErrorMessageFrom(new Error("boom"))).toBe("boom");
  });

  it("falls back to a fixed message for a non-Error throw", () => {
    expect(fleetErrorMessageFrom("not an error")).toBe("Could not load the fleet.");
  });
});

describe("runSweep", () => {
  it("POSTs an empty body to /api/sweep — the operation takes no input", async () => {
    const impl = stubFetch(200, { checkedAt: "2026-08-18T12:00:00.000Z", moves: [], released: [] });
    const outcome = await runSweep(impl);
    expect(impl.calls).toHaveLength(1);
    expect(impl.calls[0]!.url).toBe("/api/ui/sweep");
    expect(impl.calls[0]!.method).toBe("POST");
    expect(impl.calls[0]!.body).toEqual({});
    expect(outcome.ok).toBe(true);
  });

  it("reports exactly what the server says it released — never a guess", async () => {
    const impl = stubFetch(200, {
      checkedAt: "2026-08-18T12:00:00.000Z",
      moves: [{ assignmentId: "a1", itemId: "i1", from: "running", to: "dead" }],
      released: ["a1", "a2", "a3"],
    });
    const outcome = await runSweep(impl);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.released).toEqual(["a1", "a2", "a3"]);
      expect(outcome.result.moves).toHaveLength(1);
    }
  });

  it("surfaces the server's own refusal message when the call fails", async () => {
    const impl = stubFetch(500, { error: { message: "the sweep exploded" } });
    const outcome = await runSweep(impl);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toBe("the sweep exploded");
  });

  it("reports a network failure distinctly from a server refusal", async () => {
    const outcome = await runSweep(failingFetch);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/could not be reached/);
  });
});

const aTakeoverRequest: TakeoverRequest = {
  itemId: "item-1",
  fromSessionId: "sess-old",
  bySessionId: "ui-abc",
  holderType: "person",
  holderId: "person-1",
  reason: "the person running this told me to",
  force: true,
};

describe("requestTakeover", () => {
  it("POSTs the whole request body to /api/claims/takeover unchanged", async () => {
    const impl = stubFetch(200, {});
    const outcome = await requestTakeover(aTakeoverRequest, impl);
    expect(impl.calls).toHaveLength(1);
    expect(impl.calls[0]!.url).toBe("/api/ui/claims/takeover");
    expect(impl.calls[0]!.method).toBe("POST");
    expect(impl.calls[0]!.body).toEqual(aTakeoverRequest);
    expect(outcome.ok).toBe(true);
  });

  it("surfaces the guard's own warning text on a refused live-holder takeover", async () => {
    // This is the exact text `takeoverAssignment` throws
    // (`LIVE_TAKEOVER_WARNING`) when force/reason is missing or refused —
    // proving it reaches the caller unchanged, not paraphrased.
    const impl = stubFetch(422, {
      error: { message: "DANGEROUS: this holder may still be alive and working." },
    });
    const outcome = await requestTakeover(aTakeoverRequest, impl);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toBe("DANGEROUS: this holder may still be alive and working.");
    }
  });

  it("reports a network failure distinctly from a server refusal", async () => {
    const outcome = await requestTakeover(aTakeoverRequest, failingFetch);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/could not be reached/);
  });
});
