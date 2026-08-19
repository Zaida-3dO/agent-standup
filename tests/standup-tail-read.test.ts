// src/lib/standup/state.ts — where in the ledger the overnight report reads.
//
// The report is about last night, and `readSinceBounded` is
// `WHERE id > since ORDER BY id ASC LIMIT n`. So a fetch with no `since`
// takes the OLDEST n rows, not the newest: on a ledger past n events the
// page renders a confident "0 merged" about the beginning of history. These
// tests pin the read to the tail. Pure functions over a fake fetch — no DOM,
// no database.
import { describe, expect, it, vi } from "vitest";
import { tailCursor } from "@/lib/standup/state";

describe("tailCursor", () => {
  it("starts one page back from the horizon, so the page lands at the tail", () => {
    // The whole defect in one assertion: with a horizon of 2194 and a page of
    // 15, the read must begin at 2179 — not at 0, which is what an omitted
    // `since` means and what shipped.
    expect(tailCursor("2194", 15)).toBe("2179");
  });

  it("clamps to the ledger start when the ledger is shorter than one page", () => {
    // Correct rather than merely safe: there is nothing before the start to
    // miss, so the whole ledger IS the tail.
    expect(tailCursor("10", 15)).toBe("0");
    expect(tailCursor("15", 15)).toBe("0");
  });

  it("falls back to an unbounded read rather than throwing on a bad horizon", () => {
    // `undefined` makes the caller omit `since`, which is the pre-existing
    // behaviour — a wrong window, but not a crash. A new failure mode here
    // would be worse than the bug being fixed.
    expect(tailCursor("not-a-number", 15)).toBeUndefined();
    expect(tailCursor("", 15)).toBeUndefined();
  });

  it("is exact at the boundary rather than off by one", () => {
    // A page starting at `horizon - limit` and reading `id > since` yields
    // ids horizon-limit+1 .. horizon: exactly `limit` rows ending at the tip.
    const horizon = 100n;
    const limit = 15;
    const start = BigInt(tailCursor(horizon.toString(), limit)!);
    const firstReturned = start + 1n;
    expect(horizon - firstReturned + 1n).toBe(BigInt(limit));
  });
});

describe("the standup fetch reads the end of the ledger", () => {
  it("probes for the horizon and then asks for the page before it", async () => {
    // Fails if the `since` cursor is dropped: without it the request carries
    // no `since` at all and the server returns the ledger's beginning.
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes("limit=1")
        ? { events: [], cursor: "0", horizon: "2194", unseenCount: 0, firstVisit: false }
        : { events: [], cursor: "0", horizon: "2194", unseenCount: 0, firstVisit: false };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const { fetchStandup } = await import("@/lib/standup/state");
    await fetchStandup(null, new Date("2026-08-19T09:00:00.000Z"), fetchImpl as typeof fetch).catch(
      () => undefined,
    );

    // `uiApiPath` rewrites `/api/...` to the UI proxy prefix, so match on the
    // events segment rather than the literal `/api/events`.
    const feedUrls = urls.filter((u) => u.includes("/events"));
    expect(feedUrls.length).toBeGreaterThanOrEqual(2);
    // The heavy read must carry a since cursor near the tail, not start at 0.
    const heavy = feedUrls.find((u) => u.includes("full=true"));
    expect(heavy, "the full read should exist").toBeDefined();
    expect(heavy).toContain("since=2179");
  });
});
