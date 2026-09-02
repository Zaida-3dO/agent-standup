// `get_stale_candidates` against Postgres. Skips without TEST_DATABASE_URL,
// like every other DB-backed file here.
//
// The pure matcher is covered in `reconcile-citations.test.ts`. What this
// file exists to check is everything the matcher cannot see: that the SQL
// selects the right rows and the right artifacts. Those are the parts that
// fail silently — a wrong `WHERE` clause narrows the corpus, and a detector
// whose corpus is wrong reports "nothing found" exactly as convincingly as
// one that genuinely found nothing.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { GetStaleCandidatesOutput } from "@/lib/service/operations/get-stale-candidates";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A fixed id per role, so an assertion names the row it means. */
const STALE_ROW = "11111111-1111-4111-8111-111111111111";
const WORKED_ROW = "22222222-2222-4222-8222-222222222222";
const UNTOUCHED_ROW = "33333333-3333-4333-8333-333333333333";
const TERMINAL_ROW = "44444444-4444-4444-8444-444444444444";
const ARCHIVED_ROW = "55555555-5555-4555-8555-555555555555";
const OTHER_REPO_ROW = "66666666-6666-4666-8666-666666666666";
const REF_CITED_ROW = "88888888-8888-4888-8888-888888888888";

describeIfDb("get_stale_candidates against Postgres", () => {
  const dbName = scratchDatabaseName("stale_candidates");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    await prisma.area.create({ data: { id: "api", displayName: "API" } });
    await prisma.area.create({ data: { id: "infra", displayName: "Infra" } });
    await prisma.repo.create({ data: { id: "web", displayName: "Web" } });
    await prisma.repo.create({ data: { id: "desktop", displayName: "Desktop" } });

    const base = {
      kind: "task" as const,
      depth: 1,
      body: "body",
      originType: "auto" as const,
      mergeAuthority: "pre_approved" as const,
      area: "api",
    };

    await prisma.item.createMany({
      data: [
        { ...base, id: STALE_ROW, title: "Stale row", state: "on_deck", repo: "web" },
        { ...base, id: WORKED_ROW, title: "Row that did the work", state: "merged", repo: "web" },
        { ...base, id: UNTOUCHED_ROW, title: "Nobody cited this", state: "on_deck", repo: "web" },
        { ...base, id: TERMINAL_ROW, title: "Already finished", state: "merged", repo: "web" },
        {
          ...base,
          id: ARCHIVED_ROW,
          title: "Archived row",
          state: "on_deck",
          repo: "web",
          archivedAt: new Date(),
          archivedReason: "duplicate",
        },
        {
          ...base,
          id: OTHER_REPO_ROW,
          title: "Different repo",
          state: "on_deck",
          repo: "desktop",
          area: "infra",
        },
        {
          ...base,
          id: REF_CITED_ROW,
          title: "Cited only by a pull request url",
          state: "on_deck",
          repo: "web",
        },
      ],
    });

    // One commit artifact on the row that did the work, whose body names
    // every other row. That single artifact is what each assertion below
    // narrows against: whichever rows come back are the ones the SQL
    // admitted, and the ones that do not are the ones it correctly excluded.
    await prisma.artifact.create({
      data: {
        itemId: WORKED_ROW,
        kind: "commit",
        commitSha: "abc1234",
        body: `Centralised the comparison. Fixes ${STALE_ROW}, ${TERMINAL_ROW}, ${ARCHIVED_ROW} and ${OTHER_REPO_ROW}.`,
        createdByType: "agent",
        createdById: "builder-1",
      },
    });

    // A citation carried ONLY in `ref`, with no body at all. A branch or a
    // pull-request url named for the row it came from is a real convention,
    // and it is the case a corpus that reads only `body` loses silently.
    await prisma.artifact.create({
      data: {
        itemId: WORKED_ROW,
        kind: "pull_request",
        ref: `https://example.test/pull/1?row=${REF_CITED_ROW}`,
        createdByType: "agent",
        createdById: "builder-1",
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function call(input: Record<string, unknown> = {}): Promise<GetStaleCandidatesOutput> {
    return (await runtime.call("get_stale_candidates", input)) as GetStaleCandidatesOutput;
  }

  it("flags an open row named by another row's commit", async () => {
    const result = await call();
    expect(result.candidates.map((c) => c.item.id)).toContain(STALE_ROW);
  });

  it("names the row whose artifact carried the citation", async () => {
    const result = await call();
    const stale = result.candidates.find((c) => c.item.id === STALE_ROW);
    expect(stale!.evidence[0]!.citedBy).toBe(WORKED_ROW);
    expect(stale!.evidence[0]!.citedByTitle).toBe("Row that did the work");
    expect(stale!.evidence[0]!.commitSha).toBe("abc1234");
  });

  it("flags a row cited only in an artifact's ref, with no body at all", async () => {
    // Kills the corpus-narrowing mutant that reads only `body`: without
    // this row the SQL could drop every ref-only artifact and stay green.
    const result = await call({ includeUnlanded: true });
    expect(result.candidates.map((c) => c.item.id)).toContain(REF_CITED_ROW);
  });

  it("does not flag a row nobody cited", async () => {
    const result = await call();
    expect(result.candidates.map((c) => c.item.id)).not.toContain(UNTOUCHED_ROW);
  });

  it("does not flag a TERMINAL row — nothing is dispatched onto finished work", async () => {
    const result = await call();
    expect(result.candidates.map((c) => c.item.id)).not.toContain(TERMINAL_ROW);
  });

  it("does not flag an ARCHIVED row", async () => {
    // The archive sweep's concern, asserted directly here too: an archived
    // row offered as a dispatch candidate is the leak that matters.
    const result = await call();
    expect(result.candidates.map((c) => c.item.id)).not.toContain(ARCHIVED_ROW);
  });

  it("does not flag the row the citing artifact belongs to", async () => {
    const result = await call();
    expect(result.candidates.map((c) => c.item.id)).not.toContain(WORKED_ROW);
  });

  it("narrows to one repo when asked", async () => {
    const result = await call({ repo: "desktop" });
    const ids = result.candidates.map((c) => c.item.id);
    expect(ids).toContain(OTHER_REPO_ROW);
    expect(ids).not.toContain(STALE_ROW);
  });

  it("narrows to one area when asked", async () => {
    const result = await call({ area: "infra" });
    const ids = result.candidates.map((c) => c.item.id);
    expect(ids).toContain(OTHER_REPO_ROW);
    expect(ids).not.toContain(STALE_ROW);
  });

  it("reports how many rows it checked, so an empty answer is interpretable", async () => {
    const result = await call({ repo: "desktop" });
    // One non-terminal, non-archived row carries repo `desktop`.
    expect(result.rowsChecked).toBe(1);
  });

  it("reports how many artifacts it scanned and that it did not truncate", async () => {
    const result = await call();
    // The commit and the ref-only pull request; the plan added by the
    // nested suite below may or may not exist yet depending on order, so
    // this asserts the floor and the truncation flag rather than an exact
    // count that a later fixture would silently invalidate.
    expect(result.artifactsScanned).toBeGreaterThanOrEqual(2);
    expect(result.artifactScanTruncated).toBe(false);
  });

  it("carries its caveats in the payload, beside the candidates they qualify", async () => {
    const result = await call();
    expect(result.caveats.length).toBeGreaterThan(0);
    expect(result.caveats.join(" ")).toMatch(/not.*confirmed outstanding/i);
  });

  it("honours limit", async () => {
    const result = await call({ limit: 1 });
    expect(result.candidates).toHaveLength(1);
  });

  it("refuses a limit above the ceiling", async () => {
    await expect(call({ limit: 10_000 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses an unknown field, so a typo is not silently ignored", async () => {
    await expect(call({ reppo: "web" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  describe("includeUnlanded", () => {
    const PLAN_CITED_ROW = "77777777-7777-4777-8777-777777777777";

    beforeAll(async () => {
      await prisma.item.create({
        data: {
          id: PLAN_CITED_ROW,
          kind: "task",
          depth: 1,
          title: "Named only by a plan",
          body: "body",
          state: "on_deck",
          originType: "auto",
          mergeAuthority: "pre_approved",
          area: "api",
          repo: "web",
        },
      });
      await prisma.artifact.create({
        data: {
          itemId: WORKED_ROW,
          kind: "plan",
          body: `We will also cover ${PLAN_CITED_ROW}.`,
          createdByType: "agent",
          createdById: "builder-1",
        },
      });
    });

    it("hides a row whose only citation never landed, by default", async () => {
      const result = await call();
      expect(result.candidates.map((c) => c.item.id)).not.toContain(PLAN_CITED_ROW);
    });

    it("shows it when includeUnlanded is asked for, marked medium", async () => {
      const result = await call({ includeUnlanded: true });
      const found = result.candidates.find((c) => c.item.id === PLAN_CITED_ROW);
      expect(found).toBeDefined();
      expect(found!.confidence).toBe("medium");
    });

    it("still rates the commit-cited row high with includeUnlanded on", async () => {
      const result = await call({ includeUnlanded: true });
      const stale = result.candidates.find((c) => c.item.id === STALE_ROW);
      expect(stale!.confidence).toBe("high");
    });
  });
});
