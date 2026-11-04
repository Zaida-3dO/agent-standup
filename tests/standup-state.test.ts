// `fetchStandup` (src/lib/standup/state.ts): the Standup home's data load.
//
// Two things are pinned here, both born from the page going blank on a live
// installation:
//
//   1. **The overnight report reads events slim.** It asks for `full` only
//      with `types=state_change`, because the heavy shape on every event adds
//      up to several times the response-size guard over a short page, and
//      `GET /api/events` is refused (422).
//   2. **The sections load and fail independently.** The reads used to share
//      one `Promise.all`, so one refused read erased the whole page. Each
//      section now settles on its own, and a failed one carries its own short
//      message.
//
// Pure functions over a routed fake fetch: no DOM, no database.
import { describe, expect, it, vi } from "vitest";
import { fetchStandup, overlayStateChanges } from "@/lib/standup/state";
import type { SinceEvent } from "@/lib/since/types";

const NOW = new Date("2026-08-19T09:00:00.000Z");
// `defaultCutoff` is local-time based, so build the event times relative to
// the cutoff the function itself computes rather than hard-coding a clock.
const CUTOFF = (() => {
  const cutoff = new Date(NOW);
  cutoff.setHours(18, 0, 0, 0);
  if (cutoff.getTime() >= NOW.getTime()) cutoff.setDate(cutoff.getDate() - 1);
  return cutoff;
})();
const INSIDE = new Date(CUTOFF.getTime() + 60 * 60 * 1000).toISOString();
const BEFORE = new Date(CUTOFF.getTime() - 60 * 60 * 1000).toISOString();

function event(overrides: Partial<SinceEvent> = {}): SinceEvent {
  return {
    id: "1",
    itemId: "item-a",
    itemTitle: "Item A",
    ts: INSIDE,
    actorType: "agent",
    actorId: "agent-a",
    type: "note",
    seen: false,
    seenByAnyone: false,
    ...overrides,
  };
}

function feed(events: readonly SinceEvent[], overrides: Record<string, unknown> = {}) {
  return {
    events,
    cursor: "0",
    horizon: "28817",
    newestId: "2194",
    unseenCount: 0,
    firstVisit: false,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Routes {
  /** Answers a slim events read (no `full`). */
  readonly slim?: () => Response;
  /** Answers the `types=state_change` full read. */
  readonly stateChanges?: () => Response;
  readonly costs?: () => Response;
  readonly board?: () => Response;
  readonly projects?: () => Response;
  readonly needsYou?: () => Response;
}

const DEFAULT_BOARD = { board: { columns: { in_progress: { entries: [] } } } };

/** A fake `fetch` that routes by URL, recording every URL it was asked for. */
function routedFetch(routes: Routes = {}) {
  const urls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/events")) {
      // The probe for the newest id is the only read with a page size of one.
      if (/limit=1(&|$)/.test(url)) return json(feed([]));
      if (url.includes("types=state_change")) {
        return (routes.stateChanges ?? (() => json(feed([]))))();
      }
      return (routes.slim ?? (() => json(feed([]))))();
    }
    if (url.includes("/costs")) return (routes.costs ?? (() => json({ groups: [] })))();
    if (url.includes("/board")) return (routes.board ?? (() => json(DEFAULT_BOARD)))();
    if (url.includes("/projects")) {
      return (routes.projects ?? (() => json({ projects: [], childlessCount: 0 })))();
    }
    if (url.includes("/needs-you")) return (routes.needsYou ?? (() => json({ items: [] })))();
    throw new Error(`unexpected request: ${url}`);
  });
  return { impl: impl as unknown as typeof fetch, urls };
}

async function load(routes: Routes = {}, personId: string | null = "user-a") {
  const { impl, urls } = routedFetch(routes);
  const data = await fetchStandup(personId, NOW, impl);
  return { data, urls };
}

function loaded<T>(section: { status: string; data?: T; message?: string }): T {
  if (section.status !== "loaded") throw new Error(`section errored: ${section.message}`);
  return section.data as T;
}

describe("the overnight report reads events slim", () => {
  it("asks for full contents only on the state_change read", async () => {
    const { urls } = await load();
    const eventUrls = urls.filter((url) => url.includes("/events"));
    const full = eventUrls.filter((url) => url.includes("full=true"));
    expect(full).toHaveLength(1);
    expect(full[0]).toContain("types=state_change");
  });

  it("reads every other event without payload or body", async () => {
    const { urls } = await load();
    const slim = urls.filter(
      (url) => url.includes("/events") && url.includes("types=merge") && url.includes("limit=200"),
    );
    expect(slim).toHaveLength(1);
    expect(slim[0]).not.toContain("full");
  });

  it("starts both page reads from the same cursor, one span back from the newest id", async () => {
    const { urls } = await load();
    const pages = urls.filter((url) => url.includes("/events") && url.includes("limit=200"));
    expect(pages).toHaveLength(2);
    // newestId is 2194 in the fake and the span is 2,000 ids.
    for (const url of pages) expect(url).toContain("since=194");
  });

  it("counts only merge and state_change events, so it asks for only those two types", async () => {
    // Killed by dropping the types filter from the merge read: any other
    // event type could then fill the window.
    const { urls } = await load();
    const typed = urls
      .filter((url) => url.includes("/events") && url.includes("limit=200"))
      .map((url) => new URL(url, "http://localhost").searchParams.getAll("types").join(","));
    expect(typed.sort()).toEqual(["merge", "state_change"]);
  });

  it("never asks for a full read without the type filter", async () => {
    const { urls } = await load();
    for (const url of urls.filter((u) => u.includes("full=true"))) {
      expect(url).toContain("types=state_change");
    }
  });
});

describe("the overnight report still classifies moves into blocked", () => {
  it("counts a state_change into blocked from the full read, and a merge from the slim one", async () => {
    const { data } = await load({
      slim: () =>
        json(
          feed([
            event({ id: "10", type: "merge" }),
            // Slim: the same state_change, with no payload to classify it by.
            event({ id: "11", type: "state_change" }),
            event({ id: "12", type: "state_change" }),
            event({ id: "13", type: "note" }),
          ]),
        ),
      stateChanges: () =>
        json(
          feed([
            event({
              id: "11",
              type: "state_change",
              payload: { from: "executing", to: "blocked" },
            }),
            event({
              id: "12",
              type: "state_change",
              payload: { from: "planning", to: "executing" },
            }),
          ]),
        ),
    });
    const report = loaded(data.overnight);
    expect(report.merged).toHaveLength(1);
    expect(report.newlyBlocked).toHaveLength(1);
    expect(report.newlyBlocked[0]!.itemId).toBe("item-a");
  });

  it("would miss the block entirely if the state_change events stayed slim", async () => {
    // The shape the slim read alone gives: a state_change with no payload can
    // never match, so the count is 0. This pins WHY the second read exists.
    const { data } = await load({
      slim: () => json(feed([event({ id: "11", type: "state_change" })])),
      stateChanges: () => json(feed([])),
    });
    expect(loaded(data.overnight).newlyBlocked).toHaveLength(0);
  });

  it("keeps the truncation flag honest: a slim page that stops short of the cutoff says so", async () => {
    const { data } = await load({
      slim: () => json(feed([event({ id: "10", type: "merge", ts: INSIDE })])),
    });
    // The oldest event read is inside the window, so the window may extend further back.
    expect(loaded(data.overnight).eventsTruncated).toBe(true);
  });

  it("does not flag truncation when the page reaches back past the cutoff", async () => {
    const { data } = await load({
      slim: () =>
        json(
          feed([
            event({ id: "9", type: "note", ts: BEFORE }),
            event({ id: "10", type: "merge", ts: INSIDE }),
          ]),
        ),
    });
    const report = loaded(data.overnight);
    expect(report.eventsTruncated).toBe(false);
    expect(report.merged).toHaveLength(1);
  });
});

describe("each section loads and fails on its own", () => {
  it("shows every section when every read succeeds", async () => {
    const { data } = await load();
    expect(data.overnight.status).toBe("loaded");
    expect(data.inFlight.status).toBe("loaded");
    expect(data.projects.status).toBe("loaded");
    expect(data.needsYou.status).toBe("loaded");
  });

  it("keeps the other sections when the events read is refused (the live failure)", async () => {
    const { data } = await load({ slim: () => json({ error: "too large" }, 422) });
    expect(data.overnight.status).toBe("error");
    expect((data.overnight as { message: string }).message).toContain("422");
    expect(data.inFlight.status).toBe("loaded");
    expect(data.projects.status).toBe("loaded");
    expect(data.needsYou.status).toBe("loaded");
  });

  it("gives each failed section its own message", async () => {
    const { data } = await load({
      projects: () => json({}, 500),
      needsYou: () => json({}, 503),
    });
    expect((data.projects as { message: string }).message).toContain("projects");
    expect((data.projects as { message: string }).message).toContain("500");
    expect((data.needsYou as { message: string }).message).toContain("503");
    expect(data.overnight.status).toBe("loaded");
    expect(data.inFlight.status).toBe("loaded");
  });

  it("fails the in-flight section alone when the board read fails", async () => {
    const { data } = await load({ board: () => json({}, 500) });
    expect(data.inFlight.status).toBe("error");
    expect((data.inFlight as { message: string }).message).toContain("board");
    expect(data.overnight.status).toBe("loaded");
    expect(data.projects.status).toBe("loaded");
    expect(data.needsYou.status).toBe("loaded");
  });

  it("fails the projects section alone", async () => {
    const { data } = await load({ projects: () => json({}, 500) });
    expect(data.projects.status).toBe("error");
    expect(data.overnight.status).toBe("loaded");
    expect(data.inFlight.status).toBe("loaded");
    expect(data.needsYou.status).toBe("loaded");
  });

  it("fails the needs-you section alone", async () => {
    const { data } = await load({ needsYou: () => json({}, 500) });
    expect(data.needsYou.status).toBe("error");
    expect(data.overnight.status).toBe("loaded");
    expect(data.inFlight.status).toBe("loaded");
    expect(data.projects.status).toBe("loaded");
  });

  it("fails the overnight section when the state_change read fails, rather than reporting 0 blocked", async () => {
    const { data } = await load({
      slim: () => json(feed([event({ id: "11", type: "state_change" })])),
      stateChanges: () => json({}, 422),
    });
    expect(data.overnight.status).toBe("error");
    expect(data.projects.status).toBe("loaded");
  });

  it("fails the overnight section when the probe for the newest id fails", async () => {
    let calls = 0;
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/events")) {
        calls += 1;
        return json({}, 500);
      }
      if (url.includes("/costs")) return json({ groups: [] });
      if (url.includes("/board")) return json(DEFAULT_BOARD);
      if (url.includes("/projects")) return json({ projects: [] });
      return json({ items: [] });
    });
    const data = await fetchStandup("user-a", NOW, impl as unknown as typeof fetch);
    expect(calls).toBeGreaterThan(0);
    expect(data.overnight.status).toBe("error");
    expect(data.inFlight.status).toBe("loaded");
  });

  it("resolves, never rejects, when every read fails", async () => {
    const impl = vi.fn(async () => json({}, 500));
    const data = await fetchStandup("user-a", NOW, impl as unknown as typeof fetch);
    expect(data.overnight.status).toBe("error");
    expect(data.inFlight.status).toBe("error");
    expect(data.projects.status).toBe("error");
    expect(data.needsYou.status).toBe("error");
  });

  it("turns a thrown non-Error into a plain message", async () => {
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/projects")) throw "boom";
      const routed = routedFetch().impl;
      return routed(input);
    });
    const data = await fetchStandup("user-a", NOW, impl as unknown as typeof fetch);
    expect(data.projects).toEqual({ status: "error", message: "Could not load the Standup home." });
    expect(data.overnight.status).toBe("loaded");
  });

  it("turns a network failure into that section's error, not a rejection", async () => {
    const data = await fetchStandup("user-a", NOW, (async (input: RequestInfo | URL) => {
      if (String(input).includes("/needs-you")) throw new TypeError("network down");
      return routedFetch().impl(input);
    }) as typeof fetch);
    expect(data.needsYou).toEqual({ status: "error", message: "network down" });
    expect(data.projects.status).toBe("loaded");
  });
});

describe("the overnight section degrades figure by figure", () => {
  it("keeps merged and blocked counts when only the costs read fails", async () => {
    const { data } = await load({
      costs: () => json({}, 500),
      slim: () => json(feed([event({ id: "10", type: "merge" })])),
    });
    const report = loaded(data.overnight);
    expect(report.merged).toHaveLength(1);
    expect(report.cost).toBeNull();
    expect(report.costUnavailable).toBe(true);
  });

  it("does not mark spend unavailable when costs loaded but nothing was priced", async () => {
    const { data } = await load({ costs: () => json({ groups: [] }) });
    const report = loaded(data.overnight);
    expect(report.cost).toBeNull();
    expect(report.costUnavailable).toBe(false);
  });

  it("reports the live count as unknown, not zero, when the in-progress column failed", async () => {
    const { data } = await load({
      board: () => json({}, 500),
      slim: () => json(feed([event({ id: "10", type: "merge" })])),
    });
    const report = loaded(data.overnight);
    expect(report.deadOrStalledNow).toBeNull();
    expect(report.merged).toHaveLength(1);
  });

  it("counts dead and stalled assignments from the in-progress column when it loaded", async () => {
    const assignment = (liveness: string) => ({
      holderId: "agent-a",
      holderType: "agent",
      displayName: "Agent A",
      role: "builder",
      roleCustom: null,
      liveness,
      lastActive: INSIDE,
    });
    const { data } = await load({
      board: () =>
        json({
          board: {
            columns: {
              in_progress: {
                entries: [
                  {
                    item: { id: "item-a", title: "Item A" },
                    column: "in_progress",
                    assignments: [assignment("dead"), assignment("running"), assignment("stalled")],
                  },
                ],
              },
            },
          },
        }),
    });
    expect(loaded(data.overnight).deadOrStalledNow).toBe(2);
    expect(loaded(data.inFlight)).toHaveLength(1);
  });
});

describe("overlayStateChanges", () => {
  it("prefers the full event over the slim one with the same id", () => {
    const slim = [event({ id: "1", type: "state_change" }), event({ id: "2", type: "merge" })];
    const full = [event({ id: "1", type: "state_change", payload: { to: "blocked" } })];
    const merged = overlayStateChanges(slim, full);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.payload).toEqual({ to: "blocked" });
    expect(merged[1]).toBe(slim[1]);
  });

  it("keeps a full state_change the slim page did not reach", () => {
    const merged = overlayStateChanges(
      [event({ id: "1", type: "merge" })],
      [event({ id: "5", type: "state_change", payload: { to: "blocked" } })],
    );
    expect(merged.map((e) => e.id)).toEqual(["1", "5"]);
  });

  it("leaves a slim state_change alone when there is no full counterpart", () => {
    const slim = [event({ id: "1", type: "state_change" })];
    const merged = overlayStateChanges(slim, []);
    expect(merged).toEqual(slim);
    expect(merged[0]!.payload).toBeUndefined();
  });

  it("returns nothing for two empty reads, and does not mutate its inputs", () => {
    expect(overlayStateChanges([], [])).toEqual([]);
    const slim = [event({ id: "1" })];
    overlayStateChanges(slim, [event({ id: "2" })]);
    expect(slim).toHaveLength(1);
  });
});

// ── The overnight window ────────────────────────────────────────────────
//
// The report reads only the two types it counts, across a wide span of ledger
// ids, so unrelated writes cannot push last night's merges out of it. These
// cases run against a fake ledger that answers `since`, `limit`, `types` and
// `full` the way the events route does, rather than a canned page.

interface LedgerRow {
  id: number;
  type: string;
  ts: string;
  payload?: Record<string, unknown>;
}

function ledgerFetch(rows: readonly LedgerRow[]) {
  const newest = rows.reduce((max, row) => Math.max(max, row.id), 0);
  const calls: URL[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.includes("/events")) {
      if (url.pathname.includes("/costs")) return json({ groups: [] });
      if (url.pathname.includes("/board")) return json(DEFAULT_BOARD);
      if (url.pathname.includes("/projects")) return json({ projects: [], childlessCount: 0 });
      return json({ items: [] });
    }
    calls.push(url);
    const since = Number(url.searchParams.get("since") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const types = url.searchParams.getAll("types");
    const full = url.searchParams.get("full") === "true";
    const matching = rows
      .filter((row) => row.id > since && (types.length === 0 || types.includes(row.type)))
      .slice(0, limit)
      .map((row) =>
        event({
          id: String(row.id),
          type: row.type as SinceEvent["type"],
          ts: row.ts,
          itemId: `item-${row.id}`,
          itemTitle: `Item ${row.id}`,
          ...(full && row.payload ? { payload: row.payload } : {}),
        }),
      );
    return json(feed(matching, { newestId: String(newest) }));
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const eventCalls = (calls: readonly URL[], type: string) =>
  calls.filter((url) => url.searchParams.getAll("types").includes(type));

describe("the overnight window", () => {
  it("still counts a merge followed by 60 unrelated events", async () => {
    // Killed by reading the last 50 events of any type: the 60 document
    // writes would push the merge out of the window.
    const rows: LedgerRow[] = [
      { id: 1000, type: "note", ts: BEFORE },
      { id: 1001, type: "merge", ts: INSIDE },
    ];
    for (let n = 0; n < 60; n += 1) rows.push({ id: 1002 + n, type: "doc_change", ts: INSIDE });
    const { impl } = ledgerFetch(rows);
    const report = loaded((await fetchStandup("user-a", NOW, impl)).overnight);
    expect(report.merged.map((line) => line.itemId)).toEqual(["item-1001"]);
  });

  it("is not truncated when the span reaches back past the cutoff, even with nothing of the counted types before it", async () => {
    // The oldest merge is inside the window, but an older event of another
    // type shows the span began before the cutoff. Killed by judging coverage
    // by the oldest MATCHING event.
    const rows: LedgerRow[] = [
      { id: 10, type: "note", ts: BEFORE },
      { id: 11, type: "merge", ts: INSIDE },
    ];
    const { impl } = ledgerFetch(rows);
    const report = loaded((await fetchStandup("user-a", NOW, impl)).overnight);
    expect(report.eventsTruncated).toBe(false);
    expect(report.merged).toHaveLength(1);
  });

  it("is truncated when the span starts inside the window", async () => {
    const rows: LedgerRow[] = [{ id: 11, type: "merge", ts: INSIDE }];
    const { impl } = ledgerFetch(rows);
    const report = loaded((await fetchStandup("user-a", NOW, impl)).overnight);
    expect(report.eventsTruncated).toBe(true);
  });

  it("does not count the anchor event twice when it is itself a merge", async () => {
    const rows: LedgerRow[] = [
      { id: 10, type: "merge", ts: BEFORE },
      { id: 11, type: "merge", ts: INSIDE },
    ];
    const { impl } = ledgerFetch(rows);
    const report = loaded((await fetchStandup("user-a", NOW, impl)).overnight);
    expect(report.merged).toHaveLength(1);
    expect(report.eventsTruncated).toBe(false);
  });

  it("follows a full page with another request, from its last id", async () => {
    // 250 merges: one page of 200 is not the whole window. Killed by reading
    // a single page.
    const rows: LedgerRow[] = [{ id: 1, type: "note", ts: BEFORE }];
    for (let n = 0; n < 250; n += 1) rows.push({ id: 2 + n, type: "merge", ts: INSIDE });
    const { impl, calls } = ledgerFetch(rows);
    const report = loaded((await fetchStandup("user-a", NOW, impl)).overnight);

    const mergeReads = eventCalls(calls, "merge");
    expect(mergeReads).toHaveLength(2);
    expect(mergeReads[0]!.searchParams.get("since")).toBe("0");
    expect(mergeReads[1]!.searchParams.get("since")).toBe("201");
    expect(report.merged).toHaveLength(250);
    expect(report.eventsTruncated).toBe(false);
  });

  it("stops at five pages and says the counts may be incomplete", async () => {
    const rows: LedgerRow[] = [{ id: 1, type: "note", ts: BEFORE }];
    for (let n = 0; n < 1300; n += 1) rows.push({ id: 2 + n, type: "merge", ts: INSIDE });
    const { impl, calls } = ledgerFetch(rows);
    const report = loaded((await fetchStandup("user-a", NOW, impl)).overnight);

    expect(eventCalls(calls, "merge")).toHaveLength(5);
    expect(report.merged).toHaveLength(1000);
    expect(report.eventsTruncated).toBe(true);
  });

  it("starts the span 2,000 ids back from the newest id", async () => {
    const rows: LedgerRow[] = [
      { id: 5000, type: "note", ts: BEFORE },
      { id: 5001, type: "merge", ts: INSIDE },
    ];
    const { impl, calls } = ledgerFetch(rows);
    await fetchStandup("user-a", NOW, impl);
    for (const type of ["merge", "state_change"]) {
      expect(eventCalls(calls, type)[0]!.searchParams.get("since")).toBe("3001");
    }
  });

  it("still classifies a move into blocked from the full state_change read", async () => {
    const rows: LedgerRow[] = [
      { id: 10, type: "note", ts: BEFORE },
      { id: 11, type: "state_change", ts: INSIDE, payload: { from: "executing", to: "blocked" } },
      { id: 12, type: "state_change", ts: INSIDE, payload: { from: "planning", to: "executing" } },
    ];
    const { impl } = ledgerFetch(rows);
    const report = loaded((await fetchStandup("user-a", NOW, impl)).overnight);
    expect(report.newlyBlocked.map((line) => line.itemId)).toEqual(["item-11"]);
  });
});
