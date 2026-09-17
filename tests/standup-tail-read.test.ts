// src/lib/standup/state.ts — where in the ledger the overnight report reads.
//
// The report is about last night, and `readSinceBounded` is
// `WHERE id > since ORDER BY id ASC LIMIT n`. So a fetch with no `since`
// takes the OLDEST n rows, not the newest: on a ledger past n events the
// page renders a confident "0 merged" about the beginning of history. These
// tests pin the read to the tail. Pure functions over a fake fetch — no DOM,
// no database.
//
// **The cursor comes from `newestId`, never from `horizon`.** `since` is
// compared against `Event.id`; `horizon` is a Postgres transaction id
// bounding `txId`. They count different things — a transaction may append
// many events or none — so they drift apart without limit, and arithmetic on
// the horizon produces a position the `id` sequence has not reached. On a
// live installation the horizon stood at 28,817 with the newest event id at
// 15,360: a cursor derived from the horizon began ~13,400 rows past the end
// and every page came back empty, which is indistinguishable from a quiet
// night. Several tests below exist specifically to keep the two apart.
import { describe, expect, it, vi } from "vitest";
import { tailCursor } from "@/lib/standup/state";

describe("tailCursor", () => {
  it("starts one page back from the newest id, so the page lands at the tail", () => {
    // The whole defect in one assertion: with a newest id of 2194 and a page
    // of 15, the read must begin at 2179 — not at 0, which is what an omitted
    // `since` means and what shipped.
    expect(tailCursor("2194", 15)).toBe("2179");
  });

  it("clamps to the ledger start when the ledger is shorter than one page", () => {
    // Correct rather than merely safe: there is nothing before the start to
    // miss, so the whole ledger IS the tail.
    expect(tailCursor("10", 15)).toBe("0");
    expect(tailCursor("15", 15)).toBe("0");
  });

  it("falls back to an unbounded read rather than throwing on a bad id", () => {
    // `undefined` makes the caller omit `since`, which is the pre-existing
    // behaviour — a wrong window, but not a crash. A new failure mode here
    // would be worse than the bug being fixed.
    expect(tailCursor("not-a-number", 15)).toBeUndefined();
    expect(tailCursor("", 15)).toBeUndefined();
  });

  it("falls back rather than inventing a cursor when the ledger is empty", () => {
    // `newestId` is null on a ledger with no visible rows. Treating that as
    // a number would page from a position that does not exist.
    expect(tailCursor(null, 15)).toBeUndefined();
  });

  it("is exact at the boundary rather than off by one", () => {
    // A page starting at `newestId - limit` and reading `id > since` yields
    // ids newestId-limit+1 .. newestId: exactly `limit` rows ending at the tip.
    const newestId = 100n;
    const limit = 15;
    const start = BigInt(tailCursor(newestId.toString(), limit)!);
    const firstReturned = start + 1n;
    expect(newestId - firstReturned + 1n).toBe(BigInt(limit));
  });
});

describe("the standup fetch reads the end of the ledger", () => {
  /** A feed response whose `newestId` and `horizon` are deliberately different. */
  function feedBody(overrides: Record<string, unknown> = {}) {
    return {
      events: [],
      cursor: "0",
      // Far above `newestId`, exactly as a real installation's transaction
      // counter sits above its event counter.
      horizon: "28817",
      newestId: "2194",
      unseenCount: 0,
      firstVisit: false,
      ...overrides,
    };
  }

  async function capturedFeedUrls(body: Record<string, unknown>): Promise<string[]> {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
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
    return urls.filter((u) => u.includes("/events"));
  }

  it("probes for the newest id and then asks for the page before it", async () => {
    // Fails if the `since` cursor is dropped: without it the request carries
    // no `since` at all and the server returns the ledger's beginning.
    const feedUrls = await capturedFeedUrls(feedBody());
    expect(feedUrls.length).toBeGreaterThanOrEqual(2);
    const heavy = feedUrls.find((u) => u.includes("full=true"));
    expect(heavy, "the full read should exist").toBeDefined();
    expect(heavy).toContain("since=2179");
  });

  it("derives the cursor from newestId and not from the visibility horizon", async () => {
    // The regression test for the shipped bug. `horizon` here is 28817 and
    // `newestId` is 2194; reading the horizon would ask for since=28802, a
    // position ~13,400 rows past the end of the ledger, and the page would
    // come back empty while looking like a quiet night.
    const feedUrls = await capturedFeedUrls(feedBody());
    const heavy = feedUrls.find((u) => u.includes("full=true"))!;
    expect(heavy).toContain("since=2179");
    expect(heavy).not.toContain("since=28802");
  });

  it("omits since rather than paging past the end when the ledger is empty", async () => {
    // A null `newestId` with a live horizon is the empty-ledger shape. The
    // read must fall back to unbounded rather than manufacturing a cursor.
    const feedUrls = await capturedFeedUrls(feedBody({ newestId: null }));
    const heavy = feedUrls.find((u) => u.includes("full=true"))!;
    expect(heavy).not.toContain("since=");
  });
});
