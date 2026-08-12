// Guards — blocked and paused: required fields, clearing on exit.
// See docs/plans/MILESTONES.md #16, SCHEMA.md §16.
//
// Runs against a real Postgres, same convention as
// tests/state-machine-transition.test.ts — the claims here are about what
// actually got written (or didn't), which an in-memory model cannot settle.
// Skips without TEST_DATABASE_URL.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import {
  applyTransition,
  BLOCKED_PAUSED_GUARDS,
  blockedRequiredFieldsGuard,
  GuardRegistry,
  pausedRequiredFieldsGuard,
  rehearseTransition,
} from "@/lib/service/state-machine";
import { defineOperation, prismaTransactionRunner, ServiceRuntime } from "@/lib/service";
import { OPERATION_REGISTRY } from "@/lib/service/registry";
import { defaultSnapshot } from "@/lib/settings";
import type { ServiceContext } from "@/lib/service/context";
import { z } from "zod";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("blocked/paused guards, against Postgres", () => {
  const dbName = scratchDatabaseName("guards_blocked_paused");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    await prisma.person.create({ data: { id: "user-a", displayName: "user-a" } });

    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(overrides: Partial<{ state: string }> = {}) {
    taskCounter += 1;
    const id = `task-${taskCounter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${taskCounter}`,
        body: "body",
        state: (overrides.state ?? "executing") as never,
        originType: "person",
        area: "web",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function readItem(itemId: string) {
    return prisma.item.findUniqueOrThrow({ where: { id: itemId } });
  }

  /** A guard registry carrying only the two guards under test in this file. */
  function blockedPausedRegistry(): GuardRegistry {
    const reg = new GuardRegistry();
    for (const guard of BLOCKED_PAUSED_GUARDS) reg.register(guard);
    return reg;
  }

  function callTransition(
    kind: "rehearse" | "apply",
    itemId: string,
    to: string,
    fields: Record<string, unknown>,
    reg: GuardRegistry,
  ) {
    const opName = `test_guard_${kind}_${Math.random().toString(36).slice(2)}`;
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

  describe("AC1 — entering blocked requires its fields", () => {
    it("refuses blocked with none of the required fields", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const error = (await callTransition("apply", id, "blocked", {}, reg).catch(
        (e: unknown) => e,
      )) as { code?: string; guard?: string; fields?: readonly string[] };
      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe("state-machine.blocked_required_fields");
      expect(error.fields).toEqual(["blocked_reason"]);
      const row = await readItem(id);
      expect(row.state).toBe("executing"); // refused — nothing written
    });

    it("refuses blocked with an empty-string reason — presence isn't just typeof string", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const error = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "   ", blocked_on_type: "external_process" },
        reg,
      ).catch((e: unknown) => e)) as { fields?: readonly string[] };
      expect(error.fields).toEqual(["blocked_reason"]);
    });

    it("refuses blocked with a reason but no blocked_on_type", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const error = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on infra" },
        reg,
      ).catch((e: unknown) => e)) as { fields?: readonly string[] };
      expect(error.fields).toEqual(["blocked_on_type"]);
    });

    it("refuses blocked_on_type=person with no blocked_on_person", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const error = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on someone", blocked_on_type: "person" },
        reg,
      ).catch((e: unknown) => e)) as { fields?: readonly string[] };
      expect(error.fields).toEqual(["blocked_on_person"]);
    });

    it("refuses blocked_on_type=time with no unblock_at", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const error = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on a timer", blocked_on_type: "time" },
        reg,
      ).catch((e: unknown) => e)) as { fields?: readonly string[] };
      expect(error.fields).toEqual(["unblock_at"]);
    });

    it("allows blocked_on_type=external_process with just reason + type", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on a build", blocked_on_type: "external_process" },
        reg,
      );
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedReason).toBe("waiting on a build");
      expect(row.blockedOnType).toBe("external_process");
    });

    it("allows blocked with all required fields present (person)", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      await callTransition(
        "apply",
        id,
        "blocked",
        {
          blocked_reason: "waiting on user-a",
          blocked_on_type: "person",
          blocked_on_person: "user-a",
        },
        reg,
      );
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedReason).toBe("waiting on user-a");
      expect(row.blockedOnType).toBe("person");
      expect(row.blockedOnPersonId).toBe("user-a");
    });

    it("allows blocked with all required fields present (time)", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const unblockAt = new Date("2027-01-01T00:00:00.000Z");
      await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "timer", blocked_on_type: "time", unblock_at: unblockAt },
        reg,
      );
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.unblockAt?.toISOString()).toBe(unblockAt.toISOString());
    });
  });

  describe("AC2 — entering paused requires its fields", () => {
    it("refuses paused with an empty-string pause_reason", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const error = (await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "", resume_condition: "someone claims it" },
        reg,
      ).catch((e: unknown) => e)) as { fields?: readonly string[] };
      expect(error.fields).toEqual(["pause_reason"]);
    });

    it("refuses paused with neither field", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const error = (await callTransition("apply", id, "paused", {}, reg).catch(
        (e: unknown) => e,
      )) as { guard?: string; fields?: readonly string[] };
      expect(error.guard).toBe("state-machine.paused_required_fields");
      expect(error.fields).toEqual(["pause_reason"]);
      const row = await readItem(id);
      expect(row.state).toBe("executing");
    });

    it("refuses paused with pause_reason but no resume_condition", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const error = (await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "nobody on it" },
        reg,
      ).catch((e: unknown) => e)) as { fields?: readonly string[] };
      expect(error.fields).toEqual(["resume_condition"]);
    });

    it("allows paused with both fields present", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "nobody on it", resume_condition: "someone claims it" },
        reg,
      );
      const row = await readItem(id);
      expect(row.state).toBe("paused");
      expect(row.pauseReason).toBe("nobody on it");
      expect(row.resumeCondition).toBe("someone claims it");
    });
  });

  describe("AC3 — exiting blocked/paused clears the fields that state required", () => {
    it("clears every blocked_* field on a real exit from blocked", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      await callTransition(
        "apply",
        id,
        "blocked",
        {
          blocked_reason: "waiting on user-a",
          blocked_on_type: "person",
          blocked_on_person: "user-a",
        },
        reg,
      );
      await callTransition("apply", id, "executing", {}, reg);
      const row = await readItem(id);
      expect(row.state).toBe("executing");
      expect(row.blockedReason).toBeNull();
      expect(row.blockedOnType).toBeNull();
      expect(row.blockedOnPersonId).toBeNull();
      expect(row.unblockAt).toBeNull();
    });

    it("clears pause_reason and resume_condition on a real exit from paused", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "nobody on it", resume_condition: "someone claims it" },
        reg,
      );
      await callTransition("apply", id, "on_deck", {}, reg);
      const row = await readItem(id);
      expect(row.state).toBe("on_deck");
      expect(row.pauseReason).toBeNull();
      expect(row.resumeCondition).toBeNull();
    });
  });

  describe("AC4 — blocked→blocked and paused→paused re-entry does not clear the new value", () => {
    it("blocked -> blocked with a new reason ends with the new reason stored, not cleared", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      await callTransition(
        "apply",
        id,
        "blocked",
        {
          blocked_reason: "waiting on user-a",
          blocked_on_type: "person",
          blocked_on_person: "user-a",
        },
        reg,
      );

      // Re-block with a different reason and a different blocked_on_type.
      await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on a deploy window", blocked_on_type: "external_process" },
        reg,
      );

      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      // Asserting the *new* value survives — not merely that the field is
      // non-null — is what catches a fix that clears the required fields
      // whenever the transition's origin was blocked/paused, regardless of
      // where it lands: that clears exactly what a same-state re-entry just
      // validated and wrote, immediately after writing it. It also catches
      // a fix that only guards `blockedReason` and not its siblings.
      expect(row.blockedReason).toBe("waiting on a deploy window");
      expect(row.blockedOnType).toBe("external_process");
      // blocked_on_person from the first entry must not survive either —
      // the re-block didn't supply one, and external_process doesn't
      // require it.
      expect(row.blockedOnPersonId).toBeNull();
    });

    it("paused -> paused with a new reason and condition ends with the new values stored", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "waiting on review bandwidth", resume_condition: "reviewer free" },
        reg,
      );

      await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "waiting on a dependency", resume_condition: "dependency ships" },
        reg,
      );

      const row = await readItem(id);
      expect(row.state).toBe("paused");
      expect(row.pauseReason).toBe("waiting on a dependency");
      expect(row.resumeCondition).toBe("dependency ships");
    });

    it("blocked -> blocked is still refused when the new entry is missing a required field", async () => {
      // Re-entry isn't exempt from the guard just because the state didn't
      // change — an incomplete re-block must still be rejected, and the
      // original fields must survive untouched (the transaction rolled
      // back the whole operation, not just skipped the write).
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "original reason", blocked_on_type: "external_process" },
        reg,
      );

      const error = await callTransition("apply", id, "blocked", {}, reg).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");

      const row = await readItem(id);
      expect(row.blockedReason).toBe("original reason");
      expect(row.blockedOnType).toBe("external_process");
    });
  });

  describe("guard identity and registration", () => {
    it("registers into row #15's GuardRegistry under stable, distinct ids", () => {
      const reg = new GuardRegistry();
      reg.register(blockedRequiredFieldsGuard);
      reg.register(pausedRequiredFieldsGuard);
      expect(reg.has("state-machine.blocked_required_fields")).toBe(true);
      expect(reg.has("state-machine.paused_required_fields")).toBe(true);
      expect(reg.size()).toBe(2);
    });

    it("appliesTo only fires entering the state it guards, regardless of from", () => {
      expect(blockedRequiredFieldsGuard.appliesTo("executing", "blocked")).toBe(true);
      expect(blockedRequiredFieldsGuard.appliesTo("blocked", "blocked")).toBe(true);
      expect(blockedRequiredFieldsGuard.appliesTo("blocked", "executing")).toBe(false);
      expect(blockedRequiredFieldsGuard.appliesTo("paused", "paused")).toBe(false);

      expect(pausedRequiredFieldsGuard.appliesTo("executing", "paused")).toBe(true);
      expect(pausedRequiredFieldsGuard.appliesTo("paused", "paused")).toBe(true);
      expect(pausedRequiredFieldsGuard.appliesTo("paused", "executing")).toBe(false);
    });
  });

  describe("rehearsal — reports the same verdict without writing", () => {
    it("reports a rejection for a missing field on dry-run, and writes nothing", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const outcome = (await callTransition("rehearse", id, "blocked", {}, reg)) as {
        allowed: boolean;
      };
      expect(outcome.allowed).toBe(false);
      const row = await readItem(id);
      expect(row.state).toBe("executing");
      expect(row.blockedReason).toBeNull();
    });
  });
});
