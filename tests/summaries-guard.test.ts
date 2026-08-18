// The summaries guard, wired into a real transition against real Postgres.
// See docs/plans/MILESTONES.md #21, SCHEMA.md §5, §16.
//
// `tests/summaries.test.ts` proves the pure validators in isolation; this
// file proves the guard actually stops (or allows) a real
// `applyTransition` call into a completed state, and that the similarity
// check reads real `events` rows for the item rather than a hand-built
// list — the one thing the pure suite cannot exercise on its own. Same
// real-Postgres, TEST_DATABASE_URL-gated pattern as
// `tests/state-machine-transition.test.ts`.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GuardRegistry, applyTransition, rehearseTransition } from "@/lib/service/state-machine";
import { summaryRequiredGuard } from "@/lib/service/summaries";
import {
  defineOperation,
  isServiceError,
  prismaTransactionRunner,
  ServiceRuntime,
} from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import type { ServiceContext } from "@/lib/service/context";
import { z } from "zod";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("the summaries guard, against Postgres", () => {
  const dbName = scratchDatabaseName("summaries_guard");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });

    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.event.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(state = "executing"): Promise<string> {
    taskCounter += 1;
    const id = `task-${taskCounter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: `Task ${taskCounter}`,
        body: "body",
        state: state as never,
        originType: "person",
        area: "web",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function addNoteEvent(itemId: string, body: string): Promise<void> {
    await prisma.event.create({
      data: { itemId, actorType: "system", type: "note", payload: {}, body },
    });
  }

  async function readState(itemId: string): Promise<string> {
    const row = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    return row.state;
  }

  function registryWithSummaryGuard(): GuardRegistry {
    const reg = new GuardRegistry();
    reg.register(summaryRequiredGuard);
    return reg;
  }

  function callTransition(
    kind: "rehearse" | "apply",
    itemId: string,
    to: string,
    reg: GuardRegistry,
    fields?: Record<string, unknown>,
  ) {
    const opName = `test_summary_transition_${kind}_${Math.random().toString(36).slice(2)}`;
    const op = defineOperation({
      name: opName,
      kind: "write",
      summary: "test",
      input: z.object({}).strict(),
      async handler(ctx: ServiceContext) {
        return kind === "rehearse"
          ? rehearseTransition(ctx, { itemId, to, fields }, reg)
          : applyTransition(ctx, { itemId, to, fields }, reg);
      },
    });
    const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
    registry[opName] = op;
    return runtime.call(opName, {}).finally(() => {
      delete registry[opName];
    });
  }

  const validSummary = {
    shipped: ["Delivered the summaries guard."],
    not_done: [],
    user_facing: false,
    how_verified: "Ran the guard against a scratch database and inspected the rejection fields.",
    watch_for: [],
  };

  describe("applies only when entering a completed state", () => {
    it("does not fire on a non-completed target — the transition succeeds with no summary supplied", async () => {
      const reg = registryWithSummaryGuard();
      const id = await createTask("executing");
      await callTransition("apply", id, "in_review", reg); // no summary field at all
      expect(await readState(id)).toBe("in_review");
    });

    it("refuses entering 'merged' with no summary field at all", async () => {
      const reg = registryWithSummaryGuard();
      const id = await createTask("executing");
      const error = (await callTransition("apply", id, "merged", reg).catch((e: unknown) => e)) as {
        code?: string;
        guard?: string;
      };
      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe("summaries.required_and_valid");
      expect(await readState(id)).toBe("executing");
    });

    // The refusal a caller reads when they supplied nothing has to name the
    // fields, and specifically must not describe the `user_facing`
    // conditional as "the branch it forces": `branch` is a real column on
    // this same item, and a caller completing an item is thinking about the
    // git branch it merged — so that phrasing is read as a request for that
    // column and sends them to supply the wrong field.
    //
    // Fails if the message reverts to naming a branch rather than naming
    // `what_to_test` and `how_verified` outright.
    it("names the conditional fields rather than calling them a branch", async () => {
      const reg = registryWithSummaryGuard();
      const id = await createTask("executing");
      const error = (await callTransition("apply", id, "merged", reg).catch((e: unknown) => e)) as {
        message?: string;
      };
      expect(error.message).toContain("what_to_test");
      expect(error.message).toContain("how_verified");
      // The ambiguous word must not appear at all — it is the only reading
      // that costs the caller a wasted round trip.
      expect(error.message).not.toContain("branch");
    });

    it("allows entering 'merged' with a valid summary supplied", async () => {
      const reg = registryWithSummaryGuard();
      const id = await createTask("executing");
      await callTransition("apply", id, "merged", reg, { summary: validSummary });
      expect(await readState(id)).toBe("merged");
    });

    it("applies identically to each of the four completed states", async () => {
      const reg = registryWithSummaryGuard();
      for (const to of ["merged", "research_done", "wont_do", "cancelled"]) {
        const id = await createTask("executing");
        await callTransition("apply", id, to, reg, { summary: validSummary });
        expect(await readState(id)).toBe(to);
      }
    });
  });

  describe("shape rejection blocks a real transition — AC1/AC2/AC3 end to end", () => {
    it("refuses a shipped entry over the character cap and writes nothing", async () => {
      const reg = registryWithSummaryGuard();
      const id = await createTask("executing");
      const badSummary = { ...validSummary, shipped: ["x".repeat(121)] };
      const error = await callTransition("apply", id, "merged", reg, { summary: badSummary }).catch(
        (e: unknown) => e,
      );
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { fields?: string[] }).fields).toContain("shipped");
      expect(await readState(id)).toBe("executing");
    });

    it("rehearsal reports the same rejection without writing anything", async () => {
      const reg = registryWithSummaryGuard();
      const id = await createTask("executing");
      const outcome = (await callTransition("rehearse", id, "merged", reg, {
        summary: { ...validSummary, shipped: [] },
      })) as { allowed: boolean; rejection?: { guard: string } };
      expect(outcome.allowed).toBe(false);
      expect(outcome.rejection?.guard).toBe("summaries.required_and_valid");
      expect(await readState(id)).toBe("executing");
    });
  });

  describe("similarity check reads real events rows for the item — AC4", () => {
    it("refuses a shipped entry that is a near-verbatim paste of a prior event's body", async () => {
      const reg = registryWithSummaryGuard();
      const id = await createTask("executing");
      await addNoteEvent(
        id,
        "error connecting to database pool timeout after thirty seconds retry attempt three",
      );
      const pasted = {
        ...validSummary,
        shipped: [
          "error connecting to database pool timeout after thirty seconds retry attempt three.",
        ],
      };
      const error = await callTransition("apply", id, "merged", reg, { summary: pasted }).catch(
        (e: unknown) => e,
      );
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect((error as { fields?: string[] }).fields).toContain("shipped[0]");
      expect(await readState(id)).toBe("executing");
    });

    it("allows a shipped entry that genuinely differs from every prior event, even on the same item", async () => {
      const reg = registryWithSummaryGuard();
      const id = await createTask("executing");
      await addNoteEvent(id, "error connecting to database pool timeout after thirty seconds");
      const distinctSummary = {
        ...validSummary,
        shipped: ["Added the summaries guard and its similarity check."],
      };
      await callTransition("apply", id, "merged", reg, { summary: distinctSummary });
      expect(await readState(id)).toBe("merged");
    });

    it("only compares against THIS item's events, not another item's", async () => {
      const reg = registryWithSummaryGuard();
      const other = await createTask("executing");
      await addNoteEvent(
        other,
        "error connecting to database pool timeout after thirty seconds retry attempt three",
      );
      const id = await createTask("executing");
      // No event on `id` itself — the same near-verbatim text as `other`'s
      // event should NOT be flagged, because the similarity check is
      // scoped per-item (SCHEMA.md §5: "any events row for this item").
      const summary = {
        ...validSummary,
        shipped: [
          "error connecting to database pool timeout after thirty seconds retry attempt three.",
        ],
      };
      await callTransition("apply", id, "merged", reg, { summary });
      expect(await readState(id)).toBe("merged");
    });
  });

  describe("service-layer citizenship", () => {
    it("a guard rejection here is a real ServiceError, same taxonomy as every other guard", async () => {
      const reg = registryWithSummaryGuard();
      const id = await createTask("executing");
      const error = await callTransition("apply", id, "merged", reg).catch((e: unknown) => e);
      expect(isServiceError(error)).toBe(true);
    });
  });
});
