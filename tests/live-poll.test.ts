// The live feed's transport and pacing — T17.
import { describe, expect, it, vi } from "vitest";
import { backoffDelay, pollLive, POLL_INTERVAL_MS, MAX_BACKOFF_MS } from "@/lib/live/poll";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe("backoffDelay", () => {
  it("polls at the ordinary interval while nothing is failing", () => {
    expect(backoffDelay(0)).toBe(POLL_INTERVAL_MS);
    expect(backoffDelay(-1)).toBe(POLL_INTERVAL_MS);
  });

  it("doubles per consecutive failure", () => {
    expect(backoffDelay(1)).toBe(POLL_INTERVAL_MS * 2);
    expect(backoffDelay(2)).toBe(POLL_INTERVAL_MS * 4);
  });

  it("caps, so a long outage settles rather than growing without bound", () => {
    expect(backoffDelay(50)).toBe(MAX_BACKOFF_MS);
    expect(backoffDelay(1000)).toBe(MAX_BACKOFF_MS);
  });
});

describe("pollLive", () => {
  it("asks the events endpoint from the cursor it was given", async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL) =>
      Promise.resolve(jsonResponse({ events: [], cursor: "7" })),
    );
    await pollLive("7", fetchImpl as unknown as typeof fetch);

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("since=7");
    // Through the UI proxy, because a browser call carries no credential.
    expect(url).toContain("/api/ui/events");
  });

  it("asks for the full shape, because the conflict message needs the payload", async () => {
    // `payload {from, to}` is what lets a refusal say WHERE someone moved a
    // card; the slim default omits it.
    const fetchImpl = vi.fn((_url: RequestInfo | URL) =>
      Promise.resolve(jsonResponse({ events: [], cursor: "0" })),
    );
    await pollLive("0", fetchImpl as unknown as typeof fetch);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("full=true");
  });

  it("returns the slice and the server's own cursor", async () => {
    const events = [{ id: "8", itemId: "item-a", type: "state_change" }];
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ events, cursor: "8" })));

    const result = await pollLive("7", fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, events, cursor: "8" });
  });

  it("never rewinds the cursor on an out-of-order answer", async () => {
    // A slow poll started earlier answering later, carrying an older cursor.
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ events: [], cursor: "3" })));
    const result = await pollLive("9", fetchImpl as unknown as typeof fetch);
    expect(result.ok && result.cursor).toBe("9");
  });

  it("reports a non-2xx as a failure and does not advance", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ error: {} }, 500)));
    expect(await pollLive("7", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false });
  });

  it("reports an unreachable server as a failure rather than throwing", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error("offline")));
    expect(await pollLive("7", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false });
  });

  it("reports an unreadable body as a failure, not as an empty slice", async () => {
    // "Nothing happened" for a response nobody could read would let the board
    // sit silently stale forever.
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response),
    );
    expect(await pollLive("7", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false });
  });

  it("reports a body of the wrong shape as a failure", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ cursor: "8" })));
    expect(await pollLive("7", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false });
  });

  it("falls back to zero for a cursor it was handed that is not one", async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL) =>
      Promise.resolve(jsonResponse({ events: [], cursor: "0" })),
    );
    await pollLive("junk", fetchImpl as unknown as typeof fetch);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("since=0");
  });
});
