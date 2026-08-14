// What the real state machine does with the moves a drag can make —
// MILESTONES.md #73, against a real Postgres.
//
// **Why this file exists at all.** Everything else about this row is proved
// with stubs, which means every one of those tests would still pass if
// `TARGET_STATE` named states the guards refuse. This is the file that
// checks the choice against the thing that actually decides: the state
// machine. It is also what makes the refusal handling honest — the refusals
// asserted here are produced by real guards, not by a stub returning 422.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { TARGET_STATE } from "@/lib/board/drag";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("the moves a drag can make, against the real state machine", () => {
  const dbName = scratchDatabaseName("board_drag");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; kind: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      area: "drag-tests",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string; kind: string }>;
  }

  async function transitionTo(id: string, to: string | null) {
    // Every call site passes a state the test named or a non-null entry
    // from TARGET_STATE; this narrows rather than asserting so a column
    // that becomes undroppable cannot silently send `to: null`.
    if (to === null) throw new Error("no target state for that column");
    return runtime.call("transition_item", { id, to });
  }

  it("moving a task to In progress is allowed — the drop's target state is reachable", async () => {
    const project = await createItem();
    const task = await createItem({ parentId: project.id });
    const result = (await transitionTo(task.id, TARGET_STATE.in_progress)) as {
      item: { state: string };
    };
    expect(result.item.state).toBe("executing");
  });

  it("BOTH Waiting states are refused without their fields — which is why Waiting takes no drops", async () => {
    // This is the assertion that justifies `TARGET_STATE.waiting` being
    // null, and it is the one that changed the design: an earlier draft
    // chose `paused` on the reasoning that only `blocked` needed a reason.
    // The guard refused it, because `paused` needs a `pause_reason` AND a
    // `resume_condition`. With no third state to fall back on, every
    // possible drop on this column would be refused.
    const project = await createItem();
    const task = await createItem({ parentId: project.id });

    await expect(transitionTo(task.id, "paused")).rejects.toThrow(/pause_reason/);
    await expect(transitionTo(task.id, "blocked")).rejects.toThrow(/blocked_reason/);
    expect(TARGET_STATE.waiting).toBeNull();
  });

  it("moving a task back to the Backlog is allowed", async () => {
    const project = await createItem();
    const task = await createItem({ parentId: project.id });
    await transitionTo(task.id, TARGET_STATE.in_progress);
    const result = (await transitionTo(task.id, TARGET_STATE.backlog)) as {
      item: { state: string };
    };
    expect(result.item.state).toBe("on_deck");
  });

  it("a PROJECT is refused outright — it has no state to transition", async () => {
    // DECISIONS.md §13c, and the refusal the 403 branch of
    // `refusalMessage` exists for. A parentless item is a project.
    const project = await createItem();
    expect(project.kind).toBe("project");
    await expect(transitionTo(project.id, TARGET_STATE.in_progress)).rejects.toThrow(/project/i);
  });

  it("dropping on Completed is refused for an item with no summary — the guard rejection the UI reverts", async () => {
    // This move is *expected* to be refused most of the time, and that is
    // the case this row has to handle rather than a reason to forbid the
    // drop. The card springs back and the guard's own message is shown.
    const project = await createItem();
    const task = await createItem({ parentId: project.id });
    await transitionTo(task.id, TARGET_STATE.in_progress);
    await expect(transitionTo(task.id, TARGET_STATE.completed)).rejects.toThrow();
  });
});
