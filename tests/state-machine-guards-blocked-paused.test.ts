// Guards — blocked and paused: required fields, clearing on exit.
// See docs/plans/MILESTONES.md #16, SCHEMA.md §16.
//
// A missing required field nudges: the state is entered and the answer
// names what was not recorded and how to record it now (re-enter the
// state with the fields). What still refuses is a supplied
// blocked_on_type outside the legal enum — a malformed call, not a
// missing record.
//
// Runs against a real Postgres, same convention as
// tests/state-machine-transition.test.ts — the claims here are about what
// actually got written (or didn't), which an in-memory model cannot settle.
// Skips without TEST_DATABASE_URL.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
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
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    await prisma.person.create({ data: { id: "user-a", displayName: "user-a" } });

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

  describe("AC1 — entering blocked nudges when required fields are missing", () => {
    it("lands blocked with none of the required fields, warned about both at once", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition("apply", id, "blocked", {}, reg)) as {
        nudges: { guard: string; message: string }[];
      };
      expect(applied.nudges).toEqual([
        {
          guard: "state-machine.blocked_required_fields",
          // Both static requirements named in the one message — not just
          // the first one reached.
          message: expect.stringContaining("blocked requires blocked_reason, blocked_on_type."),
        },
      ]);
      // The database proves the warning travelled with the write: the item
      // is genuinely blocked, with the state's columns empty to match.
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedReason).toBeNull();
      expect(row.blockedOnType).toBeNull();
    });

    it("nudges on an empty-string reason — presence isn't just typeof string", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "   ", blocked_on_type: "external_process" },
        reg,
      )) as { nudges: { guard: string; message: string }[] };
      expect(applied.nudges).toHaveLength(1);
      expect(applied.nudges[0]?.guard).toBe("state-machine.blocked_required_fields");
      expect(applied.nudges[0]?.message).toContain("blocked requires blocked_reason.");
      // The block landed with everything the call actually carried.
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedOnType).toBe("external_process");
    });

    it("nudges with a reason but no blocked_on_type, and stores the reason it carried", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on infra" },
        reg,
      )) as { nudges: { guard: string; message: string }[] };
      expect(applied.nudges).toHaveLength(1);
      expect(applied.nudges[0]?.guard).toBe("state-machine.blocked_required_fields");
      expect(applied.nudges[0]?.message).toContain("blocked requires blocked_on_type.");
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedReason).toBe("waiting on infra");
    });

    it("names the legal blocked_on_type values in the refusal, not just the field (row c1ee5fbc-2926-4315-87dd-6d4ad2ab69e9)", async () => {
      // The original message ("blocked requires a valid blocked_on_type.")
      // named the field but not what would satisfy it — every other guard
      // that rejects an enum in this codebase (NOT_DONE_REASONS,
      // summaries/validate.ts) does list its legal values. This asserts the
      // message text itself, so reverting to the field-only phrasing fails
      // this test even though `fields` still comes back correct.
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const error = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on infra", blocked_on_type: "some_other_row" },
        reg,
      ).catch((e: unknown) => e)) as { fields?: readonly string[]; message?: string };
      expect(error.fields).toEqual(["blocked_on_type"]);
      expect(error.message).toContain("person");
      expect(error.message).toContain("external_process");
      expect(error.message).toContain("time");
      expect(error.message).toContain('"some_other_row"');
    });

    it("nudges blocked_on_type=person with no blocked_on_person", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on someone", blocked_on_type: "person" },
        reg,
      )) as { nudges: { guard: string; message: string }[] };
      expect(applied.nudges).toHaveLength(1);
      expect(applied.nudges[0]?.guard).toBe("state-machine.blocked_required_fields");
      expect(applied.nudges[0]?.message).toContain("blocked requires blocked_on_person.");
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedOnType).toBe("person");
    });

    it("nudges blocked_on_type=time with no unblock_at", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on a timer", blocked_on_type: "time" },
        reg,
      )) as { nudges: { guard: string; message: string }[] };
      expect(applied.nudges).toHaveLength(1);
      expect(applied.nudges[0]?.guard).toBe("state-machine.blocked_required_fields");
      expect(applied.nudges[0]?.message).toContain("blocked requires unblock_at.");
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedOnType).toBe("time");
    });

    // ── Row a7f39116-9281-4269-8938-539b5bbbb987 ────────────────────────
    // One warning names every requirement it already knows about, and —
    // the harder half — names no requirement that does not apply.

    it("names all three coupled requirements in ONE warning for a person block", async () => {
      // The reported defect: a caller learned reason, then type, then
      // person over three round trips. Supplying only the type that
      // implies a person must surface the reason AND the person together.
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_on_type: "person" },
        reg,
      )) as { nudges: { guard: string; message: string }[] };
      expect(applied.nudges).toHaveLength(1);
      // Asserting the message text, so reverting to a one-field-at-a-time
      // chain fails here.
      const message = applied.nudges[0]?.message ?? "";
      expect(message).toContain("blocked requires blocked_reason, blocked_on_person.");
      // The branch explanation, not just the demand list.
      expect(message).toContain("requires blocked_on_person (a person id)");
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
    });

    it("names reason and unblock_at together for a time block", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_on_type: "time" },
        reg,
      )) as { nudges: { guard: string; message: string }[] };
      expect(applied.nudges).toHaveLength(1);
      const message = applied.nudges[0]?.message ?? "";
      expect(message).toContain("blocked requires blocked_reason, unblock_at.");
      expect(message).toContain("unblock_at (a timestamp)");
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
    });

    it("does NOT demand a person for an external_process block", async () => {
      // This is the defect in reverse, and worse: over-reporting sends a
      // caller looking for a person who does not exist, with no value they
      // could supply that helps. external_process requires nothing beyond
      // reason + type, so a missing reason must be the ONLY thing the
      // warning names.
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_on_type: "external_process" },
        reg,
      )) as { nudges: { guard: string; message: string }[] };
      expect(applied.nudges).toHaveLength(1);
      const message = applied.nudges[0]?.message ?? "";
      expect(message).toContain("blocked requires blocked_reason.");
      expect(message).not.toContain("blocked_on_person");
      expect(message).not.toContain("unblock_at");
    });

    it("does not demand a time block's unblock_at from a person block, or vice versa", async () => {
      const reg = blockedPausedRegistry();
      const personId = await createTask({ state: "executing" });
      const personApplied = (await callTransition(
        "apply",
        personId,
        "blocked",
        { blocked_reason: "waiting", blocked_on_type: "person" },
        reg,
      )) as { nudges: { message: string }[] };
      expect(personApplied.nudges).toHaveLength(1);
      expect(personApplied.nudges[0]?.message).toContain("blocked requires blocked_on_person.");
      expect(personApplied.nudges[0]?.message).not.toContain("unblock_at");

      const timeId = await createTask({ state: "executing" });
      const timeApplied = (await callTransition(
        "apply",
        timeId,
        "blocked",
        { blocked_reason: "waiting", blocked_on_type: "time" },
        reg,
      )) as { nudges: { message: string }[] };
      expect(timeApplied.nudges).toHaveLength(1);
      expect(timeApplied.nudges[0]?.message).toContain("blocked requires unblock_at.");
      expect(timeApplied.nudges[0]?.message).not.toContain("blocked_on_person");
    });

    it("with no type supplied, explains both branches in prose but demands neither field", async () => {
      // A nudge carries no field list, so the demand list is the literal
      // head of the message: only the two unconditional requirements are
      // required. The conditional fields appear only inside the branch
      // explanation — described, not demanded.
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition("apply", id, "blocked", {}, reg)) as {
        nudges: { message: string }[];
      };
      expect(applied.nudges).toHaveLength(1);
      const message = applied.nudges[0]?.message ?? "";
      expect(message).toContain("blocked requires blocked_reason, blocked_on_type.");
      // ...but the prose still tells the caller what is coming, which is
      // the whole point: they can supply everything on the first retry.
      expect(message).toContain("a person block also requires blocked_on_person");
      expect(message).toContain("a time block also requires unblock_at");
      expect(message).toContain("person");
      expect(message).toContain("external_process");
      expect(message).toContain("time");
    });

    it("carries the full requirement set in the warning itself, including which types need nothing further", async () => {
      // There is no structured payload on a nudge — the whole requirement
      // set lives in the message, and this pins each part of it so a
      // phrasing change that drops one still fails here.
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition("apply", id, "blocked", {}, reg)) as {
        nudges: { message: string }[];
      };
      const message = applied.nudges[0]?.message ?? "";
      expect(message).toContain("blocked_on_type must be one of person, external_process, time");
      expect(message).toContain("a person block also requires blocked_on_person");
      expect(message).toContain("a time block also requires unblock_at");
      expect(message).toContain("external_process requires nothing further");
      // And the remedy the warning itself prescribes.
      expect(message).toContain("enter blocked again (blocked → blocked)");
    });

    it("one warning names everything still owed, and one re-entry with those fields finishes the record", async () => {
      // The end-to-end claim the row actually makes, in the nudge posture:
      // two calls, not four. The first call lands blocked and the warning
      // names both fields still missing; the second call is exactly what
      // the warning prescribes — blocked → blocked carrying those fields.
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_on_type: "person" },
        reg,
      )) as { nudges: { message: string }[] };
      expect(applied.nudges).toHaveLength(1);
      const message = applied.nudges[0]?.message ?? "";
      expect(message).toContain("blocked requires blocked_reason, blocked_on_person.");
      // The block really landed despite the gaps.
      expect((await readItem(id)).state).toBe("blocked");

      // Supply exactly what the warning named — nothing more, nothing
      // guessed.
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
      expect(row.blockedOnPersonId).toBe("user-a");
    });

    it("allows blocked_on_type=external_process with just reason + type", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "waiting on a build", blocked_on_type: "external_process" },
        reg,
      )) as { nudges: unknown[] };
      expect(applied.nudges).toEqual([]); // full evidence, full silence
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedReason).toBe("waiting on a build");
      expect(row.blockedOnType).toBe("external_process");
    });

    it("allows blocked with all required fields present (person)", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        {
          blocked_reason: "waiting on user-a",
          blocked_on_type: "person",
          blocked_on_person: "user-a",
        },
        reg,
      )) as { nudges: unknown[] };
      expect(applied.nudges).toEqual([]);
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
      const applied = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "timer", blocked_on_type: "time", unblock_at: unblockAt },
        reg,
      )) as { nudges: unknown[] };
      expect(applied.nudges).toEqual([]);
      const row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.unblockAt?.toISOString()).toBe(unblockAt.toISOString());
    });
  });

  describe("AC2 — entering paused nudges when required fields are missing", () => {
    it("nudges paused with an empty-string pause_reason — and the pause lands", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "", resume_condition: "someone claims it" },
        reg,
      )) as { nudges: { guard: string; message: string }[] };
      expect(applied.nudges).toEqual([
        {
          guard: "state-machine.paused_required_fields",
          message: expect.stringContaining("paused requires pause_reason."),
        },
      ]);
      const row = await readItem(id);
      expect(row.state).toBe("paused");
      // The condition the call did carry landed anyway.
      expect(row.resumeCondition).toBe("someone claims it");
    });

    it("nudges paused with neither field, and the pause lands", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition("apply", id, "paused", {}, reg)) as {
        nudges: { guard: string; message: string }[];
      };
      expect(applied.nudges).toHaveLength(1);
      expect(applied.nudges[0]?.guard).toBe("state-machine.paused_required_fields");
      // This guard reports one gap at a time (unlike the blocked guard's
      // named-at-once rule), so the warning names the reason and stops
      // there.
      expect(applied.nudges[0]?.message).toContain("paused requires pause_reason.");
      expect(applied.nudges[0]?.message).not.toContain("resume_condition");
      const row = await readItem(id);
      expect(row.state).toBe("paused");
    });

    it("nudges paused with pause_reason but no resume_condition", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "nobody on it" },
        reg,
      )) as { nudges: { guard: string; message: string }[] };
      expect(applied.nudges).toHaveLength(1);
      expect(applied.nudges[0]?.guard).toBe("state-machine.paused_required_fields");
      expect(applied.nudges[0]?.message).toContain("paused requires resume_condition.");
      const row = await readItem(id);
      expect(row.state).toBe("paused");
      expect(row.pauseReason).toBe("nobody on it");
    });

    it("allows paused with both fields present", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      const applied = (await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "nobody on it", resume_condition: "someone claims it" },
        reg,
      )) as { nudges: unknown[] };
      expect(applied.nudges).toEqual([]);
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

    it("blocked -> blocked keeps the stored record: an omitted field is kept, a supplied one wins, and a field already on the record is not nudged again", async () => {
      // The whole re-entry story in one walk, because the pieces only make
      // sense together. A bare first entry is nudged and stores nothing —
      // there is no record yet to keep. A re-entry that records the
      // missing fields lands clean. From then on a re-entry that leaves a
      // field out keeps the stored value (a bare `blocked → blocked` is a
      // no-op, not an erasure), and the guard counts the stored value as
      // supplied, so a partial re-entry is not nudged about fields that
      // are already on the record. A supplied value still wins.
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });

      // Fresh bare entry: nudged, and the record holds nothing.
      const bare = (await callTransition("apply", id, "blocked", {}, reg)) as {
        nudges: { guard: string; message: string }[];
      };
      expect(bare.nudges).toHaveLength(1);
      expect(bare.nudges[0]?.guard).toBe("state-machine.blocked_required_fields");
      expect(bare.nudges[0]?.message).toContain("enter blocked again");
      let row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedReason).toBeNull();
      expect(row.blockedOnType).toBeNull();

      // A bare re-entry of an empty record is still nudged: nothing stored
      // can stand in for what is missing.
      const bareAgain = (await callTransition("apply", id, "blocked", {}, reg)) as {
        nudges: { guard: string }[];
      };
      expect(bareAgain.nudges).toHaveLength(1);

      // The repair the nudge asked for: re-enter with the fields.
      const repaired = (await callTransition(
        "apply",
        id,
        "blocked",
        {
          blocked_reason: "original reason",
          blocked_on_type: "person",
          blocked_on_person: "user-a",
        },
        reg,
      )) as { nudges?: unknown[] };
      expect(repaired.nudges ?? []).toEqual([]);
      row = await readItem(id);
      expect(row.blockedReason).toBe("original reason");
      expect(row.blockedOnType).toBe("person");
      expect(row.blockedOnPersonId).toBe("user-a");

      // A bare re-entry now keeps everything and warns about nothing.
      const kept = (await callTransition("apply", id, "blocked", {}, reg)) as {
        nudges?: unknown[];
      };
      expect(kept.nudges ?? []).toEqual([]);
      row = await readItem(id);
      expect(row.state).toBe("blocked");
      expect(row.blockedReason).toBe("original reason");
      expect(row.blockedOnType).toBe("person");
      expect(row.blockedOnPersonId).toBe("user-a");

      // A partial re-entry writes only what it carries — and the stored
      // `person` type still demands its person, satisfied from the record.
      const partial = (await callTransition(
        "apply",
        id,
        "blocked",
        { blocked_reason: "a newer reason" },
        reg,
      )) as { nudges?: unknown[] };
      expect(partial.nudges ?? []).toEqual([]);
      row = await readItem(id);
      expect(row.blockedReason).toBe("a newer reason");
      expect(row.blockedOnType).toBe("person");
      expect(row.blockedOnPersonId).toBe("user-a");

      // Leaving the state is still what clears the record, and a fresh
      // entry afterwards reads only what the call carries: a reason from
      // an earlier block does not resurface.
      await callTransition("apply", id, "executing", {}, reg);
      const fresh = (await callTransition("apply", id, "blocked", {}, reg)) as {
        nudges: unknown[];
      };
      expect(fresh.nudges).toHaveLength(1);
      row = await readItem(id);
      expect(row.blockedReason).toBeNull();
      expect(row.blockedOnType).toBeNull();
      expect(row.blockedOnPersonId).toBeNull();
    });

    it("paused -> paused keeps the stored record and is not nudged for a field already recorded", async () => {
      const reg = blockedPausedRegistry();
      const id = await createTask({ state: "executing" });
      await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "waiting on review bandwidth", resume_condition: "reviewer free" },
        reg,
      );

      const partial = (await callTransition(
        "apply",
        id,
        "paused",
        { pause_reason: "waiting on a dependency" },
        reg,
      )) as { nudges?: unknown[] };
      expect(partial.nudges ?? []).toEqual([]);
      const row = await readItem(id);
      expect(row.state).toBe("paused");
      expect(row.pauseReason).toBe("waiting on a dependency");
      expect(row.resumeCondition).toBe("reviewer free");
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
    it("warns for a missing field and refuses for an invalid value, and writes nothing either way", async () => {
      // Both sides of this file's nudge/refusal line, in one rehearsal:
      // a missing required field is a warning the rehearsal reports
      // instead of a wall, and a supplied value outside the enum is
      // still a refusal — reported as an outcome, never as a throw.
      const reg = blockedPausedRegistry();

      const missing = await createTask({ state: "executing" });
      const warned = (await callTransition("rehearse", missing, "blocked", {}, reg)) as {
        allowed: boolean;
        nudges: { guard: string; message: string }[];
      };
      expect(warned.allowed).toBe(true);
      expect(warned.nudges).toEqual([
        {
          guard: "state-machine.blocked_required_fields",
          message: expect.stringContaining("enter blocked again"),
        },
      ]);

      const invalid = await createTask({ state: "executing" });
      const refused = (await callTransition(
        "rehearse",
        invalid,
        "blocked",
        { blocked_reason: "waiting", blocked_on_type: "some_other_row" },
        reg,
      )) as { allowed: boolean; rejection?: { guard: string } };
      expect(refused.allowed).toBe(false);
      expect(refused.rejection?.guard).toBe("state-machine.blocked_required_fields");

      for (const itemId of [missing, invalid]) {
        const row = await readItem(itemId);
        expect(row.state).toBe("executing");
        expect(row.blockedReason).toBeNull();
      }
    });
  });
});
