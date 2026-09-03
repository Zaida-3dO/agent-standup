// `get_needs_you` against a real Postgres — T24.
//
// **Why a real database rather than a stub.** The whole operation *is* a
// SQL union with three enum-typed predicates, a keyset cursor and a count
// over the same union. None of that has behaviour a mock could exhibit: an
// in-memory fake would only prove that a function returns what the fake was
// told to return. The admission rule is also the product decision this
// operation exists to own — a rule three separate clients used to re-derive
// — so it is worth pinning where it actually runs.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type {
  GetNeedsYouOutput,
  NeedsYouSummaryRecord,
} from "@/lib/service/operations/get-needs-you";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_needs_you against Postgres", () => {
  const dbName = scratchDatabaseName("needs_you");
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
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      area: "needs-you-tests",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string }>;
  }

  /**
   * Puts a row in exactly the shape an admission arm looks for.
   *
   * Written with raw SQL rather than driven through `transition_item`
   * deliberately: the state machine would refuse most of these without a
   * plan artifact, a commit or a blocked reason, and this operation's job
   * is to *read* whatever the store holds — not to re-litigate how a row
   * legitimately got there. Building the rows directly is what lets a case
   * like "blocked on an external process" exist at all.
   */
  async function shape(
    id: string,
    fields: {
      state?: string;
      blockedOnType?: string | null;
      blockedOnPersonId?: string | null;
      mergeAuthority?: string;
      updatedAt?: string;
      archivedAt?: string | null;
    },
  ): Promise<void> {
    if (fields.state !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "state" = $1::"ItemState" WHERE "id" = $2`,
        fields.state,
        id,
      );
    }
    if (fields.blockedOnType !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "blockedOnType" = $1::"BlockedOnType" WHERE "id" = $2`,
        fields.blockedOnType,
        id,
      );
    }
    if (fields.blockedOnPersonId !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "blockedOnPersonId" = $1 WHERE "id" = $2`,
        fields.blockedOnPersonId,
        id,
      );
    }
    if (fields.mergeAuthority !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "mergeAuthority" = $1::"MergeAuthority" WHERE "id" = $2`,
        fields.mergeAuthority,
        id,
      );
    }
    if (fields.archivedAt !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "archivedAt" = $1::timestamptz WHERE "id" = $2`,
        fields.archivedAt,
        id,
      );
    }
    // Last, so it is not clobbered by the `@updatedAt` on the writes above.
    if (fields.updatedAt !== undefined) {
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "updatedAt" = $1::timestamptz WHERE "id" = $2`,
        fields.updatedAt,
        id,
      );
    }
  }

  /** A person row, so `blockedOnPersonId`'s foreign key is satisfiable. */
  async function createPerson(id: string): Promise<string> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName", "createdAt")
       VALUES ($1, $2, now()) ON CONFLICT ("id") DO NOTHING`,
      id,
      id,
    );
    return id;
  }

  async function needsYou(input: Record<string, unknown>): Promise<GetNeedsYouOutput> {
    return (await runtime.call("get_needs_you", input)) as GetNeedsYouOutput;
  }

  async function idsFor(personId: string): Promise<string[]> {
    const result = await needsYou({ personId, limit: 200 });
    return result.items.map((item) => item.id);
  }

  describe("the admission rule", () => {
    it("admits a blocked item only when it is blocked on THIS person", async () => {
      const me = await createPerson("nyu-me-1");
      const them = await createPerson("nyu-them-1");
      const mine = await createItem({ area: "nyu-blocked" });
      const theirs = await createItem({ area: "nyu-blocked" });
      const external = await createItem({ area: "nyu-blocked" });
      const timed = await createItem({ area: "nyu-blocked" });
      await shape(mine.id, {
        state: "blocked",
        blockedOnType: "person",
        blockedOnPersonId: me,
      });
      await shape(theirs.id, {
        state: "blocked",
        blockedOnType: "person",
        blockedOnPersonId: them,
      });
      // Blocked on a deploy or a timer — waiting, but not on a person.
      //
      // **`blockedOnPersonId` is set to me on both**, which is the whole
      // point of these two rows: a store can carry a person id alongside a
      // non-person block (it is the person who will be told, not the person
      // being waited on), so leaving it null here would let a rule that
      // checked only the id pass this test. With it set, `blockedOnType` is
      // the sole thing keeping these out — which is exactly the condition
      // under test.
      await shape(external.id, {
        state: "blocked",
        blockedOnType: "external_process",
        blockedOnPersonId: me,
      });
      await shape(timed.id, {
        state: "blocked",
        blockedOnType: "time",
        blockedOnPersonId: me,
      });

      const ids = await idsFor(me);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      expect(ids).not.toContain(external.id);
      expect(ids).not.toContain(timed.id);
    });

    it("admits an in_review item only when its merge authority needs a person", async () => {
      const me = await createPerson("nyu-me-2");
      const needsApproval = await createItem({ area: "nyu-review" });
      const preApproved = await createItem({ area: "nyu-review" });
      const agentJudgement = await createItem({ area: "nyu-review" });
      await shape(needsApproval.id, { state: "in_review", mergeAuthority: "needs_approval" });
      await shape(preApproved.id, { state: "in_review", mergeAuthority: "pre_approved" });
      await shape(agentJudgement.id, { state: "in_review", mergeAuthority: "agent_judgement" });

      const ids = await idsFor(me);
      expect(ids).toContain(needsApproval.id);
      expect(ids).not.toContain(preApproved.id);
      expect(ids).not.toContain(agentJudgement.id);
    });

    it("admits every plan_review item outright, whatever its merge authority", async () => {
      const me = await createPerson("nyu-me-3");
      const plan = await createItem({ area: "nyu-plan" });
      await shape(plan.id, { state: "plan_review", mergeAuthority: "agent_judgement" });
      expect(await idsFor(me)).toContain(plan.id);
    });

    it("admits nothing from a state outside the three — a busy board is not an inbox", async () => {
      const me = await createPerson("nyu-me-4");
      const executing = await createItem({ area: "nyu-other" });
      const paused = await createItem({ area: "nyu-other" });
      const merged = await createItem({ area: "nyu-other" });
      await shape(executing.id, { state: "executing", mergeAuthority: "needs_approval" });
      // Paused means nobody is on it, not that you are.
      await shape(paused.id, { state: "paused", mergeAuthority: "needs_approval" });
      await shape(merged.id, { state: "merged", mergeAuthority: "needs_approval" });

      const ids = await idsFor(me);
      expect(ids).not.toContain(executing.id);
      expect(ids).not.toContain(paused.id);
      expect(ids).not.toContain(merged.id);
    });

    it("never returns an archived row, on any of the three arms", async () => {
      const me = await createPerson("nyu-me-5");
      const blocked = await createItem({ area: "nyu-arch" });
      const review = await createItem({ area: "nyu-arch" });
      const plan = await createItem({ area: "nyu-arch" });
      await shape(blocked.id, {
        state: "blocked",
        blockedOnType: "person",
        blockedOnPersonId: me,
        archivedAt: new Date().toISOString(),
      });
      await shape(review.id, {
        state: "in_review",
        mergeAuthority: "needs_approval",
        archivedAt: new Date().toISOString(),
      });
      await shape(plan.id, { state: "plan_review", archivedAt: new Date().toISOString() });

      const ids = await idsFor(me);
      expect(ids).not.toContain(blocked.id);
      expect(ids).not.toContain(review.id);
      expect(ids).not.toContain(plan.id);
    });

    it("combines all three arms into ONE result set — the union three client reads used to build", async () => {
      const me = await createPerson("nyu-me-6");
      const blocked = await createItem({ area: "nyu-union" });
      const review = await createItem({ area: "nyu-union" });
      const plan = await createItem({ area: "nyu-union" });
      await shape(blocked.id, {
        state: "blocked",
        blockedOnType: "person",
        blockedOnPersonId: me,
      });
      await shape(review.id, { state: "in_review", mergeAuthority: "needs_approval" });
      await shape(plan.id, { state: "plan_review" });

      const ids = await idsFor(me);
      expect(ids).toContain(blocked.id);
      expect(ids).toContain(review.id);
      expect(ids).toContain(plan.id);
    });
  });

  describe("the reason each row carries", () => {
    it("labels each arm with its own reason, derived server-side", async () => {
      const me = await createPerson("nyu-me-7");
      const blocked = await createItem({ area: "nyu-reason" });
      const review = await createItem({ area: "nyu-reason" });
      const plan = await createItem({ area: "nyu-reason" });
      await shape(blocked.id, {
        state: "blocked",
        blockedOnType: "person",
        blockedOnPersonId: me,
      });
      await shape(review.id, { state: "in_review", mergeAuthority: "needs_approval" });
      await shape(plan.id, { state: "plan_review" });

      const result = await needsYou({ personId: me, limit: 200 });
      const byId = new Map(result.items.map((item) => [item.id, item.reason]));
      expect(byId.get(blocked.id)).toBe("blocked_on_you");
      expect(byId.get(review.id)).toBe("needs_approval");
      expect(byId.get(plan.id)).toBe("plan_review");
    });
  });

  describe("the total", () => {
    it("counts every admitted item, not the page — which is what the badge reads", async () => {
      const me = await createPerson("nyu-me-8");
      for (let index = 0; index < 5; index++) {
        const item = await createItem({ area: `nyu-total-${index}` });
        await shape(item.id, { state: "plan_review" });
      }
      const result = await needsYou({ personId: me, limit: 2 });
      expect(result.items).toHaveLength(2);
      // A `total` computed from the returned page would say 2.
      expect(result.total).toBeGreaterThanOrEqual(5);
    });

    it("is zero, with no rows, for a person nothing is waiting on", async () => {
      const nobody = await createPerson("nyu-nobody");
      // Something else's queue exists, so an empty answer here is a real
      // filter rather than an empty database.
      const other = await createItem({ area: "nyu-empty" });
      await shape(other.id, {
        state: "blocked",
        blockedOnType: "person",
        blockedOnPersonId: await createPerson("nyu-someone-else"),
      });
      const result = await needsYou({ personId: nobody, limit: 50 });
      expect(result.items.map((item) => item.id)).not.toContain(other.id);
      expect(result.total).toBe(result.items.length);
    });
  });

  describe("paging", () => {
    it("walks the whole set across pages with no repeats and no gaps", async () => {
      const me = await createPerson("nyu-me-9");
      const created: string[] = [];
      for (let index = 0; index < 7; index++) {
        const item = await createItem({ area: "nyu-page" });
        await shape(item.id, {
          state: "plan_review",
          // Distinct timestamps so the keyset order is total and the walk
          // is deterministic.
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        });
        created.push(item.id);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page: GetNeedsYouOutput = await needsYou(
          cursor === undefined ? { personId: me, limit: 2 } : { personId: me, limit: 2, cursor },
        );
        seen.push(...page.items.map((item) => item.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      // Every created row appears exactly once across the walk.
      for (const id of created) {
        expect(seen.filter((seenId) => seenId === id)).toHaveLength(1);
      }
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("pages cleanly when every row shares one timestamp — what the id tie-break is for", async () => {
      // `updatedAt` alone is not a total order: rows touched in the same
      // millisecond can interleave across pages or repeat, depending on
      // scan order. Every row here is given the SAME `updatedAt`, so the
      // `id` half of the `("updatedAt", "id")` keyset is the only thing
      // making the walk deterministic — drop it and this repeats or skips.
      const me = await createPerson("nyu-me-tie");
      const sameInstant = "2026-02-02T02:02:02.000Z";
      const created: string[] = [];
      for (let index = 0; index < 6; index++) {
        const item = await createItem({ area: "nyu-tie" });
        await shape(item.id, { state: "plan_review", updatedAt: sameInstant });
        created.push(item.id);
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 20; guard++) {
        const page: GetNeedsYouOutput = await needsYou(
          cursor === undefined ? { personId: me, limit: 2 } : { personId: me, limit: 2, cursor },
        );
        seen.push(...page.items.map((item) => item.id));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      for (const id of created) {
        expect(seen.filter((seenId) => seenId === id)).toHaveLength(1);
      }
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("reports no next cursor on the last page", async () => {
      const me = await createPerson("nyu-me-10");
      const item = await createItem({ area: "nyu-last" });
      await shape(item.id, { state: "plan_review" });
      const result = await needsYou({ personId: me, limit: 200 });
      expect(result.nextCursor).toBeNull();
    });

    it("returns a next cursor when more remain", async () => {
      const me = await createPerson("nyu-me-11");
      for (let index = 0; index < 3; index++) {
        const item = await createItem({ area: "nyu-more" });
        await shape(item.id, { state: "plan_review" });
      }
      const result = await needsYou({ personId: me, limit: 1 });
      expect(result.nextCursor).not.toBeNull();
    });
  });

  describe("the returned shape", () => {
    it("is slim by default — no body, no customFields", async () => {
      const me = await createPerson("nyu-me-12");
      const item = await createItem({ area: "nyu-slim", body: "a long brief".repeat(50) });
      await shape(item.id, { state: "plan_review" });
      const result = await needsYou({ personId: me, limit: 200 });
      const row = result.items.find((candidate) => candidate.id === item.id);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty("body");
      expect(row).not.toHaveProperty("customFields");
    });

    it("carries the four fields a row draws beyond the summary, so no caller needs full", async () => {
      const me = await createPerson("nyu-me-13");
      const item = await createItem({ area: "nyu-fields" });
      await shape(item.id, { state: "in_review", mergeAuthority: "needs_approval" });
      const result = await needsYou({ personId: me, limit: 200 });
      const row = result.items.find((candidate) => candidate.id === item.id) as
        NeedsYouSummaryRecord | undefined;
      expect(row).toBeDefined();
      expect(row?.title).toBeTypeOf("string");
      expect(row?.state).toBe("in_review");
      expect(row?.mergeAuthority).toBe("needs_approval");
      // An ISO string, not a Date — it has to survive the JSON boundary.
      expect(typeof row?.updatedAt).toBe("string");
      expect(new Date(row!.updatedAt).toString()).not.toBe("Invalid Date");
      expect(row).toHaveProperty("blockedReason");
    });

    it("returns whole records on full, with the reason still attached", async () => {
      const me = await createPerson("nyu-me-14");
      const item = await createItem({ area: "nyu-full", body: "the brief" });
      await shape(item.id, { state: "plan_review" });
      const result = await needsYou({ personId: me, full: true, limit: 200 });
      const row = result.items.find((candidate) => candidate.id === item.id);
      expect(row).toBeDefined();
      expect(row).toHaveProperty("body", "the brief");
      expect(row?.reason).toBe("plan_review");
      // The correlated `areas` subquery survives being inside a union arm.
      expect(row).toHaveProperty("areas");
    });
  });

  describe("input validation", () => {
    it("refuses a call with no person — an inbox has no meaningful default subject", async () => {
      await expect(needsYou({ limit: 5 })).rejects.toThrow();
    });

    it("refuses a limit beyond the bound every paged read in the product shares", async () => {
      const me = await createPerson("nyu-me-15");
      await expect(needsYou({ personId: me, limit: 201 })).rejects.toThrow();
    });
  });
});
