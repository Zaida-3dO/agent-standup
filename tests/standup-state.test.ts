// `fetchStandup` (src/lib/standup/state.ts): the Standup home's data load.
//
// Three things are pinned here:
//
//   1. **The finished-work read is slim and reads the tail.** It asks for the
//      `merge` type only, with no `full` shape anywhere: the heavy shape on
//      every event adds up to several times the response-size guard over a
//      short page, and `GET /api/events` is then refused (422).
//   2. **The sections load and fail independently.** One refused read never
//      erases the page; each section settles on its own and a failed one
//      carries its own short message.
//   3. **The live columns and the projects list are read to their end.** The
//      in-progress and waiting columns follow `nextCursor`, projects ask for
//      the maximum page, and a read that was cut short says so ("capped"),
//      so a count on the page is never a page-size artefact.
//
// Pure functions over a routed fake fetch: no DOM, no database.
import { describe, expect, it, vi } from "vitest";
import { COLUMN_MAX_PAGES, PROJECTS_LIMIT, fetchStandup } from "@/lib/standup/state";
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
    project: null,
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

/** A board response for one column, in the shape `GET /api/board?column=` returns. */
function boardBody(
  column: string,
  entries: readonly unknown[] = [],
  extras: Record<string, unknown> = {},
) {
  return { board: { columns: { [column]: { entries, total: entries.length, ...extras } } } };
}

function boardEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    item: { id, title: `Item ${id}`, kind: "task", state: "executing", project: null },
    column: "in_progress",
    assignments: [],
    ...overrides,
  };
}

interface Routes {
  /** Answers the slim `types=merge` page read. */
  readonly slim?: () => Response;
  readonly costs?: () => Response;
  /** Answer a read of the in-progress / waiting column; receives the request URL (for its cursor). */
  readonly inProgress?: (url: URL) => Response;
  readonly waiting?: (url: URL) => Response;
  readonly projects?: () => Response;
  readonly needsYou?: () => Response;
}

/** A fake `fetch` that routes by URL, recording every URL it was asked for. */
function routedFetch(routes: Routes = {}) {
  const urls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/events")) {
      // The probe for the newest id is the only read with a page size of one
      // and no `since`.
      if (/limit=1(&|$)/.test(url)) return json(feed([]));
      return (routes.slim ?? (() => json(feed([]))))();
    }
    if (url.includes("/costs")) return (routes.costs ?? (() => json({ groups: [] })))();
    if (url.includes("/board")) {
      const parsed = new URL(url, "http://localhost");
      const column = parsed.searchParams.get("column") ?? "";
      const route = column === "waiting" ? routes.waiting : routes.inProgress;
      return (route ?? (() => json(boardBody(column))))(parsed);
    }
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

const eventUrls = (urls: readonly string[]) => urls.filter((url) => url.includes("/events"));
const pageReads = (urls: readonly string[]) =>
  eventUrls(urls).filter((url) => url.includes("limit=200"));

describe("the finished-work read is slim", () => {
  it("never asks for full contents, and reads the merge type only", async () => {
    // Killed by re-adding a `full` read, or a second page type: the heavy
    // shape is what once pushed `GET /api/events` over the response guard.
    const { urls } = await load();
    for (const url of eventUrls(urls)) expect(url).not.toContain("full");
    const typed = pageReads(urls).map((url) =>
      new URL(url, "http://localhost").searchParams.getAll("types").join(","),
    );
    expect(typed).toEqual(["merge"]);
  });

  it("starts the page read one span back from the newest id", async () => {
    const { urls } = await load();
    // newestId is 2194 in the fake and the span is 2,000 ids.
    const pages = pageReads(urls);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("since=194");
  });

  it("keeps the truncation flag honest: a page that stops short of the cutoff says so", async () => {
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

  it("carries each merge's project through to the report", async () => {
    const project = { id: "project-a", title: "Recipe box" };
    const { data } = await load({
      slim: () =>
        json(
          feed([
            event({ id: "9", type: "note", ts: BEFORE }),
            event({ id: "10", type: "merge", project }),
          ]),
        ),
    });
    expect(loaded(data.overnight).merged[0]!.project).toEqual(project);
  });
});

describe("each section loads and fails on its own", () => {
  it("shows every section when every read succeeds, and records whose page it is", async () => {
    const { data } = await load();
    expect(data.viewerId).toBe("user-a");
    for (const section of [
      data.overnight,
      data.inProgress,
      data.waiting,
      data.projects,
      data.needsYou,
    ]) {
      expect(section.status).toBe("loaded");
    }
  });

  it("keeps the other sections when the events read is refused (the live failure)", async () => {
    const { data } = await load({ slim: () => json({ error: "too large" }, 422) });
    expect(data.overnight.status).toBe("error");
    expect((data.overnight as { message: string }).message).toContain("422");
    expect(data.inProgress.status).toBe("loaded");
    expect(data.waiting.status).toBe("loaded");
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
    expect(data.inProgress.status).toBe("loaded");
  });

  it("fails one board column alone: the other column, and everything else, still load", async () => {
    const { data } = await load({ waiting: () => json({}, 500) });
    expect(data.waiting.status).toBe("error");
    expect((data.waiting as { message: string }).message).toContain("board");
    expect(data.inProgress.status).toBe("loaded");
    expect(data.overnight.status).toBe("loaded");
    expect(data.projects.status).toBe("loaded");
    expect(data.needsYou.status).toBe("loaded");

    const other = await load({ inProgress: () => json({}, 500) });
    expect(other.data.inProgress.status).toBe("error");
    expect(other.data.waiting.status).toBe("loaded");
  });

  it("fails the projects section alone", async () => {
    const { data } = await load({ projects: () => json({}, 500) });
    expect(data.projects.status).toBe("error");
    expect(data.overnight.status).toBe("loaded");
    expect(data.inProgress.status).toBe("loaded");
    expect(data.needsYou.status).toBe("loaded");
  });

  it("fails the needs-you section alone", async () => {
    const { data } = await load({ needsYou: () => json({}, 500) });
    expect(data.needsYou.status).toBe("error");
    expect(data.overnight.status).toBe("loaded");
    expect(data.inProgress.status).toBe("loaded");
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
      return routedFetch().impl(input);
    });
    const data = await fetchStandup("user-a", NOW, impl as unknown as typeof fetch);
    expect(calls).toBeGreaterThan(0);
    expect(data.overnight.status).toBe("error");
    expect(data.inProgress.status).toBe("loaded");
  });

  it("resolves, never rejects, when every read fails", async () => {
    const impl = vi.fn(async () => json({}, 500));
    const data = await fetchStandup("user-a", NOW, impl as unknown as typeof fetch);
    for (const section of [
      data.overnight,
      data.inProgress,
      data.waiting,
      data.projects,
      data.needsYou,
    ]) {
      expect(section.status).toBe("error");
    }
  });

  it("turns a thrown non-Error into a plain message", async () => {
    const impl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/projects")) throw "boom";
      return routedFetch().impl(input);
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

describe("spend degrades without erasing the finished list", () => {
  it("keeps the merges when only the costs read fails, and says spend is unavailable", async () => {
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
});

describe("the live columns are read to their end", () => {
  it("reads every level except projects, for both columns", async () => {
    // Killed by dropping the level query: the board default is level 1 only,
    // which hides an executing subtask and under-counts the agents.
    const { urls } = await load();
    const boardUrls = urls
      .filter((url) => url.includes("/board"))
      .map((url) => new URL(url, "http://localhost").searchParams);
    expect(boardUrls.map((params) => params.get("column")).sort()).toEqual([
      "in_progress",
      "waiting",
    ]);
    for (const params of boardUrls) expect(params.get("level")).toBe("exclude:0");
    // Killed by dropping `withContext`: Stuck rows lose their age and the
    // project cards lose their rows' projects.
    for (const params of boardUrls) expect(params.get("withContext")).toBe("true");
  });

  it("follows nextCursor across pages and keeps every entry", async () => {
    const { data, urls } = await load({
      inProgress: (url) =>
        url.searchParams.get("cursor") === "page-2"
          ? json(boardBody("in_progress", [boardEntry("c")], { nextCursor: null }))
          : json(
              boardBody("in_progress", [boardEntry("a"), boardEntry("b")], {
                nextCursor: "page-2",
                total: 3,
              }),
            ),
    });
    const column = loaded(data.inProgress);
    expect(column.entries.map((entry) => entry.item.id)).toEqual(["a", "b", "c"]);
    expect(column.capped).toBe(false);
    expect(column.total).toBe(3);
    const inProgressReads = urls.filter((url) => url.includes("column=in_progress"));
    expect(inProgressReads).toHaveLength(2);
    expect(inProgressReads[1]).toContain("cursor=page-2");
  });

  it("stops at the page cap and says the column is capped", async () => {
    let pages = 0;
    const { data } = await load({
      inProgress: () => {
        pages += 1;
        return json(
          boardBody("in_progress", [boardEntry(`p${pages}`)], { nextCursor: `next-${pages}` }),
        );
      },
    });
    expect(pages).toBe(COLUMN_MAX_PAGES);
    expect(loaded(data.inProgress).capped).toBe(true);
    expect(loaded(data.inProgress).entries).toHaveLength(COLUMN_MAX_PAGES);
  });

  it("fails the column rather than under-counting when a later page fails", async () => {
    const { data } = await load({
      inProgress: (url) =>
        url.searchParams.get("cursor") === null
          ? json(boardBody("in_progress", [boardEntry("a")], { nextCursor: "page-2" }))
          : json({}, 500),
    });
    expect(data.inProgress.status).toBe("error");
  });
});

describe("the projects and needs-you reads", () => {
  it("asks for the maximum page of projects, and passes nextCursor through only when present", async () => {
    const full = await load({
      projects: () => json({ projects: [], childlessCount: 0, nextCursor: "p-200" }),
    });
    expect(full.urls.find((url) => url.includes("/projects"))).toContain(`limit=${PROJECTS_LIMIT}`);
    expect(PROJECTS_LIMIT).toBe(200);
    expect(loaded(full.data.projects).nextCursor).toBe("p-200");

    const end = await load({
      projects: () => json({ projects: [], childlessCount: 0, nextCursor: null }),
    });
    expect(loaded(end.data.projects)).not.toHaveProperty("nextCursor");
  });

  it("keeps the needs-you total beside the rows, and each row's project", async () => {
    const project = { id: "project-a", title: "Recipe box" };
    const { data } = await load({
      needsYou: () =>
        json({
          items: [
            {
              id: "item-a",
              title: "Item A",
              headline: null,
              project,
              state: "plan_review",
              reason: "plan_review",
              blockedReason: null,
              updatedAt: INSIDE,
              mergeAuthority: "pre_approved",
            },
            {
              id: "item-b",
              title: "Item B",
              headline: null,
              state: "blocked",
              reason: "blocked_on_you",
              blockedReason: "Which one?",
              updatedAt: INSIDE,
              mergeAuthority: "pre_approved",
            },
          ],
          total: 7,
        }),
    });
    const read = loaded(data.needsYou);
    expect(read.total).toBe(7);
    expect(read.items).toHaveLength(2);
    expect(read.items[0]!.project).toEqual(project);
    // A response that predates the field has no project, which is null rather than undefined.
    expect(read.items[1]!.project).toBeNull();
  });
});

// ── The overnight window ────────────────────────────────────────────────
//
// The report reads only the type it counts, across a wide span of ledger ids,
// so unrelated writes cannot push last night's merges out of it. These cases
// run against a fake ledger that answers `since`, `limit` and `types` the way
// the events route does, rather than a canned page.

interface LedgerRow {
  id: number;
  type: string;
  ts: string;
}

function ledgerFetch(rows: readonly LedgerRow[]) {
  const newest = rows.reduce((max, row) => Math.max(max, row.id), 0);
  const calls: URL[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (!url.pathname.includes("/events")) {
      if (url.pathname.includes("/costs")) return json({ groups: [] });
      if (url.pathname.includes("/board")) {
        return json(boardBody(url.searchParams.get("column") ?? ""));
      }
      if (url.pathname.includes("/projects")) return json({ projects: [], childlessCount: 0 });
      return json({ items: [] });
    }
    calls.push(url);
    const since = Number(url.searchParams.get("since") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const types = url.searchParams.getAll("types");
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
        }),
      );
    return json(feed(matching, { newestId: rows.length === 0 ? null : String(newest) }));
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const mergeReads = (calls: readonly URL[]) =>
  calls.filter((url) => url.searchParams.getAll("types").includes("merge"));

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

  it("is not truncated when the span reaches back past the cutoff, even with nothing of the counted type before it", async () => {
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
    // A large newest id: the read began 2,000 ids back, so older events may exist.
    // Killed by dropping the ledger-start check the other way, always saying "complete".
    const rows: LedgerRow[] = [{ id: 5000, type: "merge", ts: INSIDE }];
    const { impl } = ledgerFetch(rows);
    const report = loaded((await fetchStandup("user-a", NOW, impl)).overnight);
    expect(report.eventsTruncated).toBe(true);
  });

  it("is not truncated when the read began at the ledger's first event", async () => {
    // Killed by reading "the span did not reach the cutoff" as "truncated" with
    // no regard to where the span began: an empty ledger read "0+ things", and so
    // did a young one whose every event is inside the window.
    const empty = ledgerFetch([]);
    const emptyReport = loaded((await fetchStandup("user-a", NOW, empty.impl)).overnight);
    expect(emptyReport.eventsTruncated).toBe(false);
    expect(emptyReport.merged).toHaveLength(0);

    const young = ledgerFetch([{ id: 40, type: "merge", ts: INSIDE }]);
    const youngReport = loaded((await fetchStandup("user-a", NOW, young.impl)).overnight);
    expect(youngReport.eventsTruncated).toBe(false);
    expect(youngReport.merged).toHaveLength(1);
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

    const reads = mergeReads(calls).filter((url) => url.searchParams.get("limit") === "200");
    expect(reads).toHaveLength(2);
    expect(reads[0]!.searchParams.get("since")).toBe("0");
    expect(reads[1]!.searchParams.get("since")).toBe("201");
    expect(report.merged).toHaveLength(250);
    expect(report.eventsTruncated).toBe(false);
  });

  it("stops at five pages and says the count may be incomplete", async () => {
    const rows: LedgerRow[] = [{ id: 1, type: "note", ts: BEFORE }];
    for (let n = 0; n < 1300; n += 1) rows.push({ id: 2 + n, type: "merge", ts: INSIDE });
    const { impl, calls } = ledgerFetch(rows);
    const report = loaded((await fetchStandup("user-a", NOW, impl)).overnight);

    expect(mergeReads(calls).filter((url) => url.searchParams.get("limit") === "200")).toHaveLength(
      5,
    );
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
    expect(mergeReads(calls)[0]!.searchParams.get("since")).toBe("3001");
  });
});
