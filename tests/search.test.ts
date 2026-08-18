// MILESTONES.md #105 — search over items.
//
// **What would make this file hollow, stated first so it can be checked.**
// Search is unusually easy to test vacuously: seed one item, search for a
// word in it, assert it comes back. That passes against an implementation
// that ignores the query and returns every row, against one that ranks
// nothing, and against one that searches only the title. So the assertions
// below are shaped around the three things that are actually claims:
//
//   1. **Something is excluded.** A search that returns a non-matching item
//      is not a search. Every corpus below contains rows that must NOT come
//      back, and the assertions name them.
//   2. **The order is the product.** "Ranked matches" is the row's own
//      wording, so ordering is asserted as an *order* — a title match ahead
//      of a body match for the same query — rather than as set membership,
//      which any unordered implementation would satisfy.
//   3. **The defaults differ from every other read here, on purpose.** This
//      is the one read whose default includes finished work, and a test
//      that only ever searched open items would pass identically against a
//      copy of `list_items`' default. The terminal-state cases are what
//      make the row's actual behaviour observable.
//
// The ranking half needs no database and is tested as pure functions, which
// is why `search-rank.ts` is a separate module: an opinion about ordering is
// worth stating as an assertion about a function rather than inferring from
// which of two seeded rows came back first.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { buildExcerpt, rankMatch } from "@/lib/service/items/search-rank";
import {
  escapeLikePattern,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MIN_QUERY_CHARS,
  RANK_CANDIDATE_CEILING,
  buildSearchNotice,
  type SearchOutput,
} from "@/lib/service/operations/search";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

describe("search is a registered read, reachable on every adapter", () => {
  // The row asks for "a service call and its routes/tools/verb". Adapters
  // are derived from the registry, so registration as a `read` is what makes
  // the MCP tool, the HTTP route table entry and the CLI verb reachable —
  // and `tests/adapter-*.test.ts` enforce the rest from the same source.
  it("is in the operation registry, declared as a read", () => {
    expect(OPERATION_REGISTRY.search).toBeDefined();
    expect(OPERATION_REGISTRY.search.kind).toBe("read");
  });

  // The summary is what a caller reading a tool list sees, and the one place
  // the inverted default is stated before they hit it. A summary that failed
  // to mention it would leave the surprise to be discovered by a wrong answer.
  it("says in its summary that it searches finished work too", () => {
    expect(OPERATION_REGISTRY.search.summary).toMatch(/finished work/i);
  });
});

describe("ranking — a title match beats a body match", () => {
  // The row's word is "ranked". These are the assertions that make that
  // more than a claim, and they are about the ordering *rule*, not about
  // any particular pair of seeded rows.
  it("scores a title match above a body match for the same query", () => {
    const inTitle = rankMatch(
      { title: "the hook script", headline: null, body: "unrelated" },
      "hook",
    );
    const inBody = rankMatch(
      { title: "unrelated", headline: null, body: "the hook script" },
      "hook",
    );
    expect(inTitle!.score).toBeGreaterThan(inBody!.score);
    expect(inTitle!.matchedIn).toBe("title");
    expect(inBody!.matchedIn).toBe("body");
  });

  it("scores a headline match between the two", () => {
    const inHeadline = rankMatch(
      { title: "unrelated", headline: "the hook script", body: "nope" },
      "hook",
    );
    const inBody = rankMatch(
      { title: "unrelated", headline: null, body: "the hook script" },
      "hook",
    );
    const inTitle = rankMatch({ title: "the hook script", headline: null, body: "nope" }, "hook");
    expect(inHeadline!.score).toBeGreaterThan(inBody!.score);
    expect(inTitle!.score).toBeGreaterThan(inHeadline!.score);
    expect(inHeadline!.matchedIn).toBe("headline");
  });

  // The load-bearing negative on the weighting scheme: the gaps are wide
  // specifically so that accumulated weak evidence cannot outrank one strong
  // match. Adjacent weights (3/2/1) would fail this and look reasonable.
  it("does not let a headline-and-body match overtake a title match", () => {
    const titleOnly = rankMatch({ title: "hook", headline: null, body: "nothing here" }, "hook");
    const bothWeak = rankMatch(
      { title: "nothing here", headline: "hook", body: "hook hook hook" },
      "hook",
    );
    expect(titleOnly!.score).toBeGreaterThan(bothWeak!.score);
  });

  it("ranks an exact title above a title that merely contains the query", () => {
    const exact = rankMatch({ title: "search", headline: null, body: "" }, "search");
    const contains = rankMatch({ title: "search over items", headline: null, body: "" }, "search");
    expect(exact!.score).toBeGreaterThan(contains!.score);
  });

  it("ranks a match starting a word above one buried inside another word", () => {
    const wordStart = rankMatch(
      { title: "a search over items", headline: null, body: "" },
      "search",
    );
    const midWord = rankMatch({ title: "a researcher writes", headline: null, body: "" }, "search");
    expect(wordStart!.score).toBeGreaterThan(midWord!.score);
  });

  it("accumulates across fields, so matching twice beats matching once", () => {
    const twice = rankMatch({ title: "hook", headline: null, body: "the hook again" }, "hook");
    const once = rankMatch({ title: "hook", headline: null, body: "nothing" }, "hook");
    expect(twice!.score).toBeGreaterThan(once!.score);
    // …but the reported field is still the strongest single one, not a list.
    expect(twice!.matchedIn).toBe("title");
  });

  // The negative that proves the ranker is reading the query at all.
  it("returns null when the query is in none of the fields", () => {
    expect(rankMatch({ title: "alpha", headline: "beta", body: "gamma" }, "delta")).toBeNull();
  });

  it("matches case-insensitively, agreeing with the ILIKE that selected the row", () => {
    expect(
      rankMatch({ title: "The Hook Script", headline: null, body: "" }, "hook script"),
    ).not.toBeNull();
  });
});

describe("the excerpt — the evidence a match actually happened", () => {
  it("centres on the match rather than on the start of the body", () => {
    const body = `${"x".repeat(300)} the needle here ${"y".repeat(300)}`;
    const excerpt = buildExcerpt(body, "needle");
    expect(excerpt).toContain("needle");
    // Shortened, or it would be the whole body under another name.
    expect(excerpt!.length).toBeLessThan(body.length);
  });

  // The load-bearing negative: an excerpt that did not contain the match
  // would look like evidence and be none.
  it("is null when the body does not contain the query, rather than an arbitrary opening slice", () => {
    expect(buildExcerpt("a body with no match in it", "absent")).toBeNull();
  });

  it("marks only the ends it actually cut", () => {
    const exact = buildExcerpt("needle", "needle");
    expect(exact).toBe("needle");
    expect(exact).not.toContain("…");
  });
});

describe("escaping — a caller's wildcard is literal text", () => {
  // **Why this is tested here rather than through a search.** Two mechanisms
  // independently require a literal match: this escaping, and the ranker's
  // own `indexOf`, which drops any row the pattern let through. That is the
  // right design — but it means removing the escaping changes no result a
  // caller can see, so a test written against search results passes against
  // a broken escaper. Verified by doing exactly that: with the escaping
  // removed, the SQL returned an extra row and the ranker filtered it back
  // out. The defect is only observable here.
  // The expectations are built from `BACKSLASH` rather than written as
  // escape sequences, because the assertion is *about* backslashes: a
  // literal like "50\\%" is easy to miscount by one and would then assert
  // the wrong string convincingly.
  const BACKSLASH = String.fromCharCode(92);

  it("escapes a percent sign, which would otherwise match any run of characters", () => {
    expect(escapeLikePattern("50%")).toBe(`50${BACKSLASH}%`);
  });

  it("escapes an underscore, which would otherwise match any single character", () => {
    expect(escapeLikePattern("a_b")).toBe(`a${BACKSLASH}_b`);
  });

  // The escape character itself has to be escaped first, or escaping `%`
  // would produce a backslash the pattern then reads as escaping something
  // else.
  it("escapes a backslash", () => {
    expect(escapeLikePattern(`a${BACKSLASH}b`)).toBe(`a${BACKSLASH}${BACKSLASH}b`);
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeLikePattern("the hook script")).toBe("the hook script");
  });
});

describe("the notice a search carries", () => {
  // Search is the one read whose empty result is ambiguous — "no such item"
  // and "your filters hid it" look identical — so the notice has to tell
  // them apart. This is #109 part 3's self-routing principle reaching the
  // case those reads do not have: a call that succeeded and found nothing.
  it("distinguishes a genuinely absent item from one the filters hid", () => {
    const unfiltered = buildSearchNotice(0, "hook", false, false);
    const filtered = buildSearchNotice(0, "hook", false, true);
    expect(unfiltered).not.toBe(filtered);
    expect(filtered).toMatch(/filters/i);
    expect(unfiltered).toMatch(/any title, headline or body/i);
  });

  it("routes a caller to the full record rather than returning it", () => {
    expect(buildSearchNotice(3, "hook", false, false)).toContain("get_item");
  });

  it("says outright when more matched than were ranked", () => {
    const truncated = buildSearchNotice(20, "e", true, false);
    expect(truncated).toMatch(/narrow the query/i);
    expect(buildSearchNotice(20, "e", false, false)).not.toMatch(/narrow the query/i);
  });

  it("says `item` rather than `items` for a single match", () => {
    expect(buildSearchNotice(1, "hook", false, false)).toContain("1 item");
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("search over a real corpus", () => {
  const dbName = scratchDatabaseName("search");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  const AREA = "search-tests";
  const OTHER_AREA = "search-tests-other";

  async function call(input: Record<string, unknown>): Promise<SearchOutput> {
    return (await runtime.call("search", input as never)) as SearchOutput;
  }

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    for (const area of [AREA, OTHER_AREA]) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
        area,
      );
    }
    // `Item.repo` is a foreign key, so the repo the filter narrows to has
    // to exist before an item can name it.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Repo" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
      "web",
    );

    // The corpus is built so that every assertion below has something that
    // must NOT come back — a search that returned everything would fail
    // rather than pass.
    await seed({
      id: "s-title",
      title: "Search over items",
      body: "unrelated prose",
      state: "executing",
    });
    await seed({
      id: "s-body",
      title: "Unrelated title",
      body: "this brief mentions search once",
      state: "executing",
    });
    await seed({
      id: "s-headline",
      title: "Unrelated title",
      headline: "adds search to the product",
      body: "nothing",
      state: "executing",
    });
    await seed({
      id: "s-merged",
      title: "Search ranking, shipped",
      body: "nothing",
      state: "merged",
    });
    await seed({
      id: "s-cancelled",
      title: "Search, abandoned",
      body: "nothing",
      state: "cancelled",
    });
    await seed({
      id: "s-other-area",
      title: "Search in another area",
      body: "nothing",
      state: "executing",
      area: OTHER_AREA,
    });
    await seed({
      id: "s-repo",
      title: "Search in a repo",
      body: "nothing",
      state: "executing",
      repo: "web",
    });
    await seed({
      id: "s-absent",
      title: "Nothing to do with it",
      body: "no mention at all",
      state: "executing",
    });
    // The wildcard pair. Searching for the literal `50%` must find the row
    // that really contains it and NOT the decoy — unescaped, the pattern
    // becomes `%50%%`, whose `%` matches any run of characters and so also
    // matches "A 50 then off sale". A single row containing a `%` would be
    // matched with or without the escape, which is why the decoy is what
    // makes this assertion mean anything.
    await seed({
      id: "s-wildcard-literal",
      title: "A 50% off sale",
      body: "nothing",
      state: "executing",
    });
    await seed({
      id: "s-wildcard-decoy",
      title: "A 50 then off sale",
      body: "nothing",
      state: "executing",
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function seed(row: {
    id: string;
    title: string;
    body: string;
    state: string;
    headline?: string;
    area?: string;
    repo?: string;
  }): Promise<void> {
    const area = row.area ?? AREA;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Item" ("id", "kind", "title", "headline", "body", "state", "priority", "area", "repo", "originType", "driveMode", "mergeAuthority", "createdAt", "updatedAt")
       VALUES ($1, 'task'::"ItemKind", $2, $3, $4, $5::"ItemState", 'P2'::"Priority", $6, $7, 'auto'::"OriginType", 'autonomous'::"DriveMode", 'agent_judgement'::"MergeAuthority", now(), now())`,
      row.id,
      row.title,
      row.headline ?? null,
      row.body,
      row.state,
      area,
      row.repo ?? null,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      row.id,
      area,
    );
  }

  it("finds an item by a phrase in its title", async () => {
    const result = await call({ query: "Search over items" });
    expect(result.matches[0]?.id).toBe("s-title");
  });

  it("finds an item by text that appears only in its body", async () => {
    const result = await call({ query: "mentions search once" });
    expect(result.matches.map((m) => m.id)).toEqual(["s-body"]);
    expect(result.matches[0]?.matchedIn).toBe("body");
  });

  it("finds an item by text that appears only in its headline", async () => {
    const result = await call({ query: "adds search to the product" });
    expect(result.matches.map((m) => m.id)).toEqual(["s-headline"]);
    expect(result.matches[0]?.matchedIn).toBe("headline");
  });

  // The assertion that a search is a search: the non-matching row is absent.
  it("excludes an item that does not match", async () => {
    const result = await call({ query: "search" });
    expect(result.matches.map((m) => m.id)).not.toContain("s-absent");
    expect(result.matches.length).toBeGreaterThan(0);
  });

  // The row's word is "ranked", and this is that claim end to end rather
  // than as a unit of the ranker.
  it("orders a title match ahead of a body match for the same query", async () => {
    const ids = (await call({ query: "search" })).matches.map((m) => m.id);
    expect(ids.indexOf("s-title")).toBeLessThan(ids.indexOf("s-body"));
  });

  // #105's defining difference from every other read here. A test suite
  // without this would pass against a copy of `list_items`' default.
  it("returns finished work by default, unlike the list reads", async () => {
    const ids = (await call({ query: "search" })).matches.map((m) => m.id);
    expect(ids).toContain("s-merged");
    expect(ids).toContain("s-cancelled");
  });

  it("drops finished work when openOnly is asked for", async () => {
    const ids = (await call({ query: "search", openOnly: true })).matches.map((m) => m.id);
    expect(ids).not.toContain("s-merged");
    expect(ids).not.toContain("s-cancelled");
    expect(ids).toContain("s-title");
  });

  // The silently-empty-result trap `list_items` documents: an explicit state
  // must win over the default, or asking for merged work and receiving
  // nothing looks like "no such item".
  it("honours an explicit terminal state even alongside openOnly", async () => {
    const ids = (await call({ query: "search", state: "merged", openOnly: true })).matches.map(
      (m) => m.id,
    );
    expect(ids).toEqual(["s-merged"]);
  });

  it("narrows by area, excluding a match in another area", async () => {
    const ids = (await call({ query: "search", area: AREA })).matches.map((m) => m.id);
    expect(ids).not.toContain("s-other-area");
    expect(ids).toContain("s-title");
  });

  it("narrows by repo", async () => {
    const ids = (await call({ query: "search", repo: "web" })).matches.map((m) => m.id);
    expect(ids).toEqual(["s-repo"]);
  });

  it("returns a slim row, never the body", async () => {
    const match = (await call({ query: "Search over items" })).matches[0]!;
    expect(match).toHaveProperty("title");
    expect(match).toHaveProperty("state");
    expect(match).not.toHaveProperty("body");
    expect(match).not.toHaveProperty("customFields");
  });

  it("carries an excerpt showing where a body match was found", async () => {
    const match = (await call({ query: "mentions search once" })).matches[0]!;
    expect(match.excerpt).toContain("mentions search once");
  });

  // End to end, a caller's `%` finds the row that really contains one. This
  // is the *outcome* assertion; the escaping that produces it is asserted
  // directly in its own test above, for the reason given there.
  it("finds an item whose title contains a literal percent sign", async () => {
    const ids = (await call({ query: "50%" })).matches.map((m) => m.id);
    expect(ids).toEqual(["s-wildcard-literal"]);
  });

  it("finds nothing for a query in no item, and says so", async () => {
    const result = await call({ query: "quaxolotl" });
    expect(result.matches).toEqual([]);
    expect(result.notice).toMatch(/no item matches/i);
  });

  it("tells a caller its filters may be why nothing came back", async () => {
    const result = await call({ query: "search", repo: "no-such-repo" });
    expect(result.matches).toEqual([]);
    expect(result.notice).toMatch(/filters/i);
  });

  it("refuses a query too short to mean anything", async () => {
    await expect(call({ query: "a" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a missing query rather than returning the whole corpus", async () => {
    await expect(call({})).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("bounds a page by default and caps what a caller can ask for", async () => {
    expect(DEFAULT_SEARCH_LIMIT).toBeGreaterThan(0);
    expect(DEFAULT_SEARCH_LIMIT).toBeLessThanOrEqual(MAX_SEARCH_LIMIT);
    expect(MIN_QUERY_CHARS).toBeGreaterThan(1);
    await expect(call({ query: "search", limit: MAX_SEARCH_LIMIT + 1 })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("honours a smaller limit than the number of matches", async () => {
    const result = await call({ query: "search", limit: 2 });
    expect(result.matches).toHaveLength(2);
  });

  it("returns a stable order for a repeated identical query", async () => {
    const first = (await call({ query: "search" })).matches.map((m) => m.id);
    const second = (await call({ query: "search" })).matches.map((m) => m.id);
    expect(first).toEqual(second);
  });

  it("reports honestly that it did not truncate a small result", async () => {
    const result = await call({ query: "search" });
    expect(result.truncated).toBe(false);
    expect(result.considered).toBe(result.matches.length);
  });
});

// A broad query against a corpus larger than the ranking ceiling — the case
// that decides whether `truncated` is a real signal or a field that is
// always false. Separated because it needs its own, much larger corpus.
describeIfDb("a query broader than the ranking ceiling", () => {
  const dbName = scratchDatabaseName("search_ceiling");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1) ON CONFLICT DO NOTHING`,
      "ceiling",
    );
    // Deliberately more matching rows than the ceiling ranks, so truncation
    // is exercised rather than assumed.
    const total = RANK_CANDIDATE_CEILING + 25;
    for (let i = 0; i < total; i++) {
      const id = `ceiling-${i}`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Item" ("id", "kind", "title", "body", "state", "priority", "area", "originType", "driveMode", "mergeAuthority", "createdAt", "updatedAt")
         VALUES ($1, 'task'::"ItemKind", $2, 'body', 'executing'::"ItemState", 'P2'::"Priority", 'ceiling', 'auto'::"OriginType", 'autonomous'::"DriveMode", 'agent_judgement'::"MergeAuthority", now() - ($3 || ' seconds')::interval, now())`,
        id,
        `widespread token number ${i}`,
        String(i),
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ItemArea" ("itemId", "areaId") VALUES ($1, 'ceiling') ON CONFLICT DO NOTHING`,
        id,
      );
    }
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  it("says outright that it ranked only part of what matched", async () => {
    const result = (await runtime.call("search", { query: "widespread" } as never)) as SearchOutput;
    expect(result.truncated).toBe(true);
    expect(result.considered).toBe(RANK_CANDIDATE_CEILING);
    expect(result.notice).toMatch(/narrow the query/i);
  });

  // The bound is the point: a broad query must not return the corpus.
  it("still returns only a page, not every match", async () => {
    const result = (await runtime.call("search", { query: "widespread" } as never)) as SearchOutput;
    expect(result.matches.length).toBeLessThanOrEqual(DEFAULT_SEARCH_LIMIT);
  });
});
