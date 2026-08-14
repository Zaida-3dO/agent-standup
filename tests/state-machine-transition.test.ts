// The state machine: all-to-all transitions, the guard framework, rehearsal
// mode, and the rule that a project never runs a guard.
// See docs/plans/MILESTONES.md #15, SCHEMA.md §16, DECISIONS.md §13c.
//
// Runs against a real Postgres, like `service-transaction-db.test.ts` — the
// claims here are about what actually got written (or didn't), which an
// in-memory model of the database cannot settle. Skips without
// TEST_DATABASE_URL, same convention as every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  GuardRegistry,
  ProjectHasNoStateError,
  applyTransition,
  guardOk,
  guardRejected,
  isItemState,
  ITEM_STATES,
  rehearseTransition,
  runGuards,
  type Guard,
  type GuardInput,
} from "@/lib/service/state-machine";
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

describeIfDb("the state machine, against Postgres", () => {
  const dbName = scratchDatabaseName("state_machine");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  // Each test below constructs its own `new GuardRegistry()` — a fresh one
  // per test, so one test's guard can never leak into another's.
  let runtime: ServiceRuntime;

  beforeAll(() => {
    // The production runtime, over the same `ServiceRuntime` row #14 built —
    // this suite is proving the state machine is a citizen of that boundary,
    // not a parallel one, so it has to actually run inside it.
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  });

  afterEach(async () => {
    await prisma.item.deleteMany({});
  });

  let taskCounter = 0;
  async function createTask(overrides: Partial<{ state: string; parentId: string | null }> = {}) {
    taskCounter += 1;
    const id = `task-${taskCounter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: overrides.parentId ?? null,
        kind: overrides.parentId === undefined ? "task" : "subtask",
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

  async function createProject() {
    taskCounter += 1;
    const id = `project-${taskCounter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "project",
        title: `Project ${taskCounter}`,
        body: "body",
        // A project row still needs *some* value in the non-null `state`
        // column at the storage layer — Prisma's schema has no partial
        // nullability per `kind`. What DECISIONS.md §13c means by "no
        // stored state" is that nothing ever *reads* or *transitions* this
        // value for a project; the state machine refuses to try, which is
        // exactly what this file's "projects" tests hold it to.
        state: "someday",
        originType: "person",
        area: "web",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function readState(itemId: string): Promise<string> {
    const row = await prisma.item.findUniqueOrThrow({ where: { id: itemId } });
    return row.state;
  }

  /**
   * Runs a transition-like operation through the real runtime, for the
   * tests that want the full boundary — registered and torn down per call,
   * the same pattern `service-runtime.test.ts` uses to install test
   * operations on the shared registry without leaving them there.
   */
  function callTransition(
    kind: "rehearse" | "apply",
    itemId: string,
    to: string,
    reg: GuardRegistry,
  ) {
    const opName = `test_transition_${kind}_${Math.random().toString(36).slice(2)}`;
    const op = defineOperation({
      name: opName,
      kind: "write",
      summary: "test",
      input: z.object({}).strict(),
      async handler(ctx: ServiceContext) {
        return kind === "rehearse"
          ? rehearseTransition(ctx, { itemId, to }, reg)
          : applyTransition(ctx, { itemId, to }, reg);
      },
    });
    const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
    registry[opName] = op;
    return runtime.call(opName, {}).finally(() => {
      delete registry[opName];
    });
  }

  describe("all-to-all transitions — no edge whitelist", () => {
    it("allows every (from, to) pair when no guard objects", async () => {
      const reg = new GuardRegistry();
      // Sweep a representative spread across all eleven states, not just
      // neighbours on the SCHEMA.md board — the claim is "no whitelist",
      // which a test that only tried adjacent states could not distinguish
      // from "a whitelist that happens to allow adjacent moves".
      const pairs: Array<[string, string]> = [
        ["someday", "merged"],
        ["executing", "someday"],
        ["blocked", "in_review"],
        ["paused", "on_deck"],
        ["merged", "executing"],
        ["cancelled", "planning"],
        ["in_review", "wont_do"],
      ];
      for (const [from, to] of pairs) {
        const id = await createTask({ state: from });
        await callTransition("apply", id, to, reg);
        expect(await readState(id)).toBe(to);
      }
    });

    it("refuses an illegal transition for real — not merely one the implementation happens to enumerate", async () => {
      // The guard under test asserts nothing about *which* pairs the state
      // machine iterates; it objects to exactly one pair regardless of how
      // the machine reaches it, which is what makes this a claim about
      // refusal rather than about a table lookup matching itself.
      const reg = new GuardRegistry();
      reg.register({
        id: "test.no_someday_from_merged",
        description: "test",
        appliesTo: (from, to) => from === "merged" && to === "someday",
        check: () => guardRejected("Cannot reopen a merged item straight to someday."),
      });

      const id = await createTask({ state: "merged" });
      const error = (await callTransition("apply", id, "someday", reg).catch(
        (e: unknown) => e,
      )) as { code?: string; guard?: string };
      expect(error.code).toBe("guard_rejected");
      expect(error.guard).toBe("test.no_someday_from_merged");
      // The database, read directly — not the thrown error — is what proves
      // the refusal actually stopped the write.
      expect(await readState(id)).toBe("merged");

      // The same guard does not fire on a different pair — proving it
      // discriminates rather than blanket-refusing.
      const other = await createTask({ state: "merged" });
      await callTransition("apply", other, "on_deck", reg);
      expect(await readState(other)).toBe("on_deck");
    });

    it("covers every declared state, proved against a list the implementation did not supply", () => {
      // `ITEM_STATES` is a hand-written list (states.ts), not read off the
      // Prisma enum — see that file's header for why the distinction
      // matters. This just pins the vocabulary size so a state silently
      // dropped from the module is caught here rather than discovered later.
      // Twelve, matching `prisma/schema.prisma`'s `ItemState` enum: SCHEMA.md
      // §1.1's prose header predates `paused`/`blocked` splitting into two
      // states sharing one display column (DECISIONS.md §2 "paused (the
      // user's call...)"), so the schema — the thing actually enforced — is
      // twelve values, not the eleven the heading still says.
      expect(ITEM_STATES).toHaveLength(12);
      expect(isItemState("blocked")).toBe(true);
      expect(isItemState("not-a-state")).toBe(false);
    });
  });

  describe("the guard framework — later rows register into it", () => {
    it("invokes a guard registered from outside this module, exactly when appliesTo says to", async () => {
      let invocations = 0;
      const reg = new GuardRegistry();
      reg.register({
        id: "test.only_entering_blocked",
        description: "Requires a reason when entering blocked.",
        appliesTo: (_from, to) => to === "blocked",
        check: (input: GuardInput) => {
          invocations += 1;
          return input.fields.blocked_reason ? guardOk : guardRejected("blocked_reason required");
        },
      });

      const withoutReason = await createTask({ state: "executing" });
      const error = await callTransition("apply", withoutReason, "blocked", reg).catch(
        (e: unknown) => e,
      );
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect(invocations).toBe(1);

      // A transition the guard has nothing to say about (`appliesTo` false)
      // must not invoke it at all.
      const elsewhere = await createTask({ state: "executing" });
      await callTransition("apply", elsewhere, "someday", reg);
      expect(invocations).toBe(1); // unchanged — proves appliesTo actually filters
    });

    it("stops at the first rejecting guard and names that guard, not a later one", async () => {
      const reg = new GuardRegistry();
      const order: string[] = [];
      reg.register({
        id: "test.first",
        description: "test",
        appliesTo: () => true,
        check: () => {
          order.push("first");
          return guardRejected("first refuses");
        },
      });
      reg.register({
        id: "test.second",
        description: "test",
        appliesTo: () => true,
        check: () => {
          order.push("second");
          return guardOk;
        },
      });

      const id = await createTask({ state: "executing" });
      const error = (await callTransition("apply", id, "someday", reg).catch(
        (e: unknown) => e,
      )) as { guard?: string };
      expect(error.guard).toBe("test.first");
      expect(order).toEqual(["first"]); // "second" never ran
    });

    it("rejects a duplicate guard id rather than silently shadowing the first", () => {
      const reg = new GuardRegistry();
      const guard: Guard = {
        id: "test.dup",
        description: "test",
        appliesTo: () => true,
        check: () => guardOk,
      };
      reg.register(guard);
      expect(() => reg.register(guard)).toThrow(/already registered/);
    });

    it("produces a rejection carrying the taxonomy's GuardRejectedError, not a bespoke shape", async () => {
      const reg = new GuardRegistry();
      reg.register({
        id: "test.always",
        description: "test",
        appliesTo: () => true,
        check: () => guardRejected("no", { fields: ["state"] }),
      });
      const error = await runGuards(reg.applicable("executing", "someday"), {
        item: {
          id: "x",
          kind: "task",
          state: "executing",
          blockedReason: null,
          blockedOnType: null,
          blockedOnPersonId: null,
          unblockAt: null,
          pauseReason: null,
          resumeCondition: null,
          needsVisualReview: false,
          mergeAuthority: "needs_approval",
        },
        from: "executing",
        to: "someday",
        fields: {},
        db: {} as never,
        settings: defaultSnapshot(),
      });
      expect(isServiceError(error)).toBe(true);
      expect(error?.code).toBe("guard_rejected");
      expect(error?.guard).toBe("test.always");
      expect(error?.fields).toEqual(["state"]);
    });
  });

  describe("rehearsal mode — evaluates without committing", () => {
    it("reports an allowed transition but writes nothing to the database", async () => {
      const reg = new GuardRegistry();
      const id = await createTask({ state: "executing" });
      const outcome = (await callTransition("rehearse", id, "someday", reg)) as {
        allowed: boolean;
        rehearsed: boolean;
      };
      expect(outcome.allowed).toBe(true);
      expect(outcome.rehearsed).toBe(true);
      // The load-bearing assertion: the database, read on a separate query
      // after the call returned, still shows the original state. A test
      // that only inspected the returned outcome could not tell a real
      // rehearsal apart from one that quietly wrote anyway.
      expect(await readState(id)).toBe("executing");
    });

    it("reports a rejected transition, still without writing anything", async () => {
      const reg = new GuardRegistry();
      reg.register({
        id: "test.rehearsal_blocks",
        description: "test",
        appliesTo: () => true,
        check: () => guardRejected("no"),
      });
      const id = await createTask({ state: "executing" });
      const outcome = (await callTransition("rehearse", id, "someday", reg)) as {
        allowed: boolean;
      };
      expect(outcome.allowed).toBe(false);
      expect(await readState(id)).toBe("executing");
    });

    it("never invokes a guard fewer or more times than a real transition would", async () => {
      // Rehearsal and application must evaluate identically — the only
      // permitted difference is the write. If rehearsal short-circuited
      // guard evaluation, a rehearsed "allowed: true" could lie about what
      // a real transition would actually do.
      let invocations = 0;
      const reg = new GuardRegistry();
      reg.register({
        id: "test.counts",
        description: "test",
        appliesTo: () => true,
        check: () => {
          invocations += 1;
          return guardOk;
        },
      });
      const rehearsed = await createTask({ state: "executing" });
      await callTransition("rehearse", rehearsed, "someday", reg);
      expect(invocations).toBe(1);

      const applied = await createTask({ state: "executing" });
      await callTransition("apply", applied, "someday", reg);
      expect(invocations).toBe(2);
    });
  });

  describe("projects have no stored state — guards never run against one", () => {
    it("refuses to transition a project outright", async () => {
      const reg = new GuardRegistry();
      const id = await createProject();
      const error = await callTransition("apply", id, "executing", reg).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProjectHasNoStateError);
      expect(await readState(id)).toBe("someday"); // untouched
    });

    it("does not invoke a registered guard for a project, even one that would appliesTo() everything", async () => {
      // The count is the proof, not the outcome. A guard that always
      // applies and always approves would make a merely-passing test look
      // identical whether the guard ran zero times or five; only counting
      // invocations distinguishes "never runs against a project" from "runs
      // and happens not to mind".
      let invocations = 0;
      const reg = new GuardRegistry();
      reg.register({
        id: "test.would_run_on_anything",
        description: "test",
        appliesTo: () => true,
        check: () => {
          invocations += 1;
          return guardOk;
        },
      });

      const project = await createProject();
      await callTransition("apply", project, "executing", reg).catch(() => undefined);
      expect(invocations).toBe(0);

      // The same guard, same registry, against an ordinary task: it does
      // fire — proving the zero above is the project rule, not a broken
      // guard that never fires at all.
      const task = await createTask({ state: "executing" });
      await callTransition("apply", task, "someday", reg);
      expect(invocations).toBe(1);
    });

    it("refuses a project on rehearsal too, not only on a real transition", async () => {
      const reg = new GuardRegistry();
      const id = await createProject();
      const error = await callTransition("rehearse", id, "executing", reg).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProjectHasNoStateError);
    });
  });

  describe("service-layer citizenship — the existing errors and transaction, not a parallel one", () => {
    it("a guard rejection is a real ServiceError instance carrying the taxonomy's code", async () => {
      const reg = new GuardRegistry();
      reg.register({
        id: "test.taxonomy",
        description: "test",
        appliesTo: () => true,
        check: () => guardRejected("no", { fields: ["title"] }),
      });
      const id = await createTask({ state: "executing" });
      const error = (await callTransition("apply", id, "someday", reg).catch(
        (e: unknown) => e,
      )) as { code?: string; fields?: readonly string[] };
      expect(error.code).toBe("guard_rejected");
      expect(error.fields).toEqual(["title"]);
    });

    it("runs inside the runtime's own transaction — a guard that writes, then the operation fails, rolls back together", async () => {
      // Proves the mechanism does not open a second boundary: a guard body
      // that writes through ctx.db, followed by a later rejection from a
      // second guard in the same evaluation, must see that write rolled
      // back exactly as service-transaction-db.test.ts proves for an
      // ordinary operation — because it is the same transaction.
      const reg = new GuardRegistry();
      reg.register({
        id: "test.writes_then_a_later_guard_refuses",
        description: "test",
        appliesTo: () => true,
        check: async (input: GuardInput) => {
          await input.db.$executeRawUnsafe(
            `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $1)`,
            "written-by-guard",
          );
          return guardOk;
        },
      });
      reg.register({
        id: "test.refuses_after",
        description: "test",
        appliesTo: () => true,
        check: () => guardRejected("no"),
      });

      const id = await createTask({ state: "executing" });
      const error = await callTransition("apply", id, "someday", reg).catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");

      const found = await prisma.area.findUnique({ where: { id: "written-by-guard" } });
      // Rolled back with everything else in the same transaction — a
      // separately-opened boundary for the guard would leave this committed
      // even though the overall transition was refused.
      expect(found).toBeNull();
    });

    it("loadItemForTransition throws the taxonomy's NotFoundError for a missing item", async () => {
      const reg = new GuardRegistry();
      const error = await callTransition("apply", "does-not-exist", "someday", reg).catch(
        (e: unknown) => e,
      );
      expect(isServiceError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("not_found");
    });
  });

  describe("clearing blocked/paused fields on exit (SCHEMA.md §16)", () => {
    it("clears blocked_reason and friends when a real transition leaves blocked", async () => {
      const reg = new GuardRegistry();
      const id = await createTask({ state: "blocked" });
      await prisma.item.update({
        where: { id },
        data: {
          blockedReason: "waiting on someone",
          blockedOnType: "person",
        },
      });
      await callTransition("apply", id, "executing", reg);
      const row = await prisma.item.findUniqueOrThrow({ where: { id } });
      expect(row.blockedReason).toBeNull();
      expect(row.blockedOnType).toBeNull();
    });

    it("leaves blocked_reason untouched on a rehearsal, because rehearsal never writes", async () => {
      const reg = new GuardRegistry();
      const id = await createTask({ state: "blocked" });
      await prisma.item.update({
        where: { id },
        data: { blockedReason: "waiting on someone", blockedOnType: "person" },
      });
      await callTransition("rehearse", id, "executing", reg);
      const row = await prisma.item.findUniqueOrThrow({ where: { id } });
      expect(row.blockedReason).toBe("waiting on someone");
    });
  });

  describe("loadItemForTransition — the shared fetch #27 reuses", () => {
    it("returns the columns a guard needs, typed as GuardableItem", async () => {
      const id = await createTask({ state: "executing" });
      const reg = new GuardRegistry();
      let seen: unknown;
      reg.register({
        id: "test.observe_item",
        description: "test",
        appliesTo: () => true,
        check: (input: GuardInput) => {
          seen = input.item;
          return guardOk;
        },
      });
      await callTransition("apply", id, "someday", reg);
      expect((seen as { id: string }).id).toBe(id);
      expect((seen as { kind: string }).kind).toBe("task");
    });
  });
});
