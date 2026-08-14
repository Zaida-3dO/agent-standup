// Which states stamp `completedAt`, asserted over every state rather than
// over the four somebody remembered.
//
// `applyTransition` decided this from its own inline
// `new Set(["merged", "research_done", "wont_do", "cancelled"])` — a fourth
// hardcoded copy of the terminal-state list, sitting next to the docstring in
// `board/columns.ts` that argues at length against writing that list out a
// second time. Adding a thirteenth completed state would have updated
// `TERMINAL_STATES` automatically and left this one stale, so an item could
// reach a finished state with a null `completedAt` and nothing would notice.
//
// No test covered `completedAt` at all, which is why the copy survived. This
// file closes that: it drives a real transition into **every** state in
// `ITEM_STATES` and asserts the stamp appears exactly where `isTerminalState`
// says it should. Because both sides are derived — the states from the state
// list, the expectation from the shared predicate — a new state is covered
// the day it is added, with no edit here.
//
// Runs against a real Postgres: `completedAt` is set by a `CASE` inside the
// UPDATE statement, so nothing short of the real write settles it. Skips
// without TEST_DATABASE_URL, the same convention as every other DB-backed
// file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GuardRegistry, applyTransition, ITEM_STATES } from "@/lib/service/state-machine";
import { isTerminalState, TERMINAL_STATES } from "@/lib/service/board/columns";
import { defineOperation, prismaTransactionRunner, ServiceRuntime } from "@/lib/service";
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

describeIfDb("completedAt follows the shared terminal-state list", () => {
  const dbName = scratchDatabaseName("transition_completed_at");
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
    await prisma.item.deleteMany({});
  });

  let counter = 0;
  async function createTask(state = "executing"): Promise<string> {
    counter += 1;
    const id = `completed-at-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Task ${counter}`,
        body: "body",
        state: state as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  /**
   * Moves an item to `to` with an empty guard registry, so no guard can
   * interfere, and returns the resulting `completedAt`.
   *
   * Goes through the real `applyTransition` inside the production runtime's
   * transaction — the `CASE` that sets the column exists only in that
   * statement, so calling anything shallower would test a different thing.
   * The operation is registered and torn down per call, the same pattern
   * `state-machine-transition.test.ts` uses to avoid leaving test operations
   * on the shared registry.
   */
  async function moveTo(itemId: string, to: string): Promise<Date | null> {
    const guards = new GuardRegistry();
    const opName = `test_completed_at_${Math.random().toString(36).slice(2)}`;
    const op = defineOperation({
      name: opName,
      kind: "write",
      summary: "test",
      input: z.object({}).strict(),
      async handler(ctx: ServiceContext) {
        return applyTransition(ctx, { itemId, to }, guards);
      },
    });
    const registry = OPERATION_REGISTRY as unknown as Record<string, unknown>;
    registry[opName] = op;
    await runtime.call(opName, {}).finally(() => {
      delete registry[opName];
    });

    const row = await prisma.item.findUnique({ where: { id: itemId } });
    return row?.completedAt ?? null;
  }

  it("stamps completedAt for every terminal state, and for no other state", async () => {
    // The exhaustive pass. Iterating `ITEM_STATES` rather than a list written
    // here is the whole point: a thirteenth state joins this test by existing.
    for (const to of ITEM_STATES) {
      const itemId = await createTask();
      const completedAt = await moveTo(itemId, to);

      if (isTerminalState(to)) {
        // Swapping `isTerminalState(to)` in transition.ts for a hardcoded
        // set that omits any one state makes this fail for that state.
        expect(completedAt, `expected ${to} to stamp completedAt`).not.toBeNull();
      } else {
        // The half that stops "stamp it always" from passing. A transition
        // to `executing` or `blocked` is not a completion.
        expect(completedAt, `expected ${to} to leave completedAt null`).toBeNull();
      }
    }
  });

  it("covers at least one state on each side, so the loop above cannot pass vacuously", () => {
    // Guards the guard. If `ITEM_STATES` were empty, or every state were
    // terminal, the loop would assert nothing meaningful while still passing.
    const terminal = ITEM_STATES.filter((state) => isTerminalState(state));
    const live = ITEM_STATES.filter((state) => !isTerminalState(state));
    expect(terminal.length).toBeGreaterThan(0);
    expect(live.length).toBeGreaterThan(0);
    // And the predicate agrees with the exported list it is derived from.
    expect([...terminal].sort()).toEqual([...TERMINAL_STATES].sort());
  });

  it("clears nothing on re-entry — a terminal item transitioned again keeps a stamp", async () => {
    const itemId = await createTask();
    const first = await moveTo(itemId, "merged");
    expect(first).not.toBeNull();

    // `completedAt` uses `CASE WHEN ... THEN now() ELSE "completedAt" END`,
    // so a later non-terminal move must leave the existing value alone rather
    // than nulling it. An item reopened out of `merged` has still genuinely
    // been completed once, and these states are a read-filter convention
    // rather than a one-way door in the state machine.
    const afterReopen = await moveTo(itemId, "executing");
    expect(afterReopen).not.toBeNull();
    expect(afterReopen?.getTime()).toBe(first?.getTime());
  });
});
