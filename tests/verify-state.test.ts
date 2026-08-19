// Recording a check of an item's stored `state` — MILESTONES.md #131.
// Driven with a stub `fetch`, so a refusal (a missing commitSha, a missing
// createdById) is exercised without a server — same shape as
// `tests/board-move.test.ts`.
import { describe, expect, it } from "vitest";
import { verifyState } from "@/lib/item-detail/verify-state";

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

const validInput = {
  itemId: "item-1",
  commitSha: "abc123",
  body: "Checked against the tip commit — the stored state matches.",
  createdByType: "person" as const,
  createdById: "user-a",
};

describe("verifyState", () => {
  it("POSTs a historical_verification artifact to the item's artifacts endpoint", async () => {
    const impl = stubFetch(201, { artifact: { id: "art-1" } });
    const result = await verifyState(validInput, impl);
    expect(result.ok).toBe(true);
    expect(impl.calls).toHaveLength(1);
    expect(impl.calls[0]!.url).toBe("/api/ui/items/item-1/artifacts");
    expect(impl.calls[0]!.method).toBe("POST");
    expect(impl.calls[0]!.body).toEqual({
      kind: "historical_verification",
      commitSha: "abc123",
      body: validInput.body,
      createdByType: "person",
      createdById: "user-a",
    });
  });

  it("encodes the item id in the URL", async () => {
    const impl = stubFetch(201, { artifact: { id: "art-1" } });
    await verifyState({ ...validInput, itemId: "item with spaces" }, impl);
    expect(impl.calls[0]!.url).toBe("/api/ui/items/item%20with%20spaces/artifacts");
  });

  // The server's own refusal text is worth more than anything invented here
  // — same reasoning `requestMove` follows for a transition refusal.
  it("surfaces the server's own refusal message", async () => {
    const impl = stubFetch(422, {
      error: {
        message: "A historical_verification must record the commitSha it was checked against.",
      },
    });
    const result = await verifyState(validInput, impl);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      message: "A historical_verification must record the commitSha it was checked against.",
    });
  });

  it("falls back to the HTTP status when the error body carries no message", async () => {
    const impl = stubFetch(500, {});
    const result = await verifyState(validInput, impl);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, message: "The server refused this (HTTP 500)." });
  });

  it("reports a network failure without throwing", async () => {
    const result = await verifyState(validInput, failingFetch);
    expect(result.ok).toBe(false);
  });
});
