// Guard — hierarchy: a parent cannot finish while a child is still
// actionable. See docs/plans/MILESTONES.md #19, SCHEMA.md §5a, §1.1.
//
// Runs against a real Postgres, like `state-machine-transition.test.ts` —
// the claims here are about rows actually written or refused, which an
// in-memory model cannot settle. Skips without TEST_DATABASE_URL.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GuardRegistry, applyTransition, hierarchyGuard, rehearseTransition } from "@/lib/service";
import type { GuardInput } from "@/lib/service";
import { ITEM_STATES } from "@/lib/service/state-machine";
import { defaultSnapshot } from "@/lib/settings";
import type { TransactionHandle } from "@/lib/service";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

// The four "completed" states this guard fires on entering — the same set
// `hierarchy.ts` declares as `COMPLETED_STATES`, re-declared here from
// SCHEMA.md §1.1's "Completed" column so the test's expectation does not
// come from importing the module under test's own constant.
const FINISHING_STATES = ["merged", "research_done", "wont_do", "cancelled"];

// Every state that is NOT one of {blocked, paused, merged, research_done,
// wont_do, cancelled} — read off SCHEMA.md §1.1's columns independently of
// `hierarchy.ts`'s own `NON_ACTIONABLE_STATES`, for the same reason.
const ACTIONABLE_STATES = [
  "someday",
  "on_deck",
  "planning",
  "plan_review",
  "executing",
  "in_review",
];
const NON_ACTIONABLE_STATES = ["blocked", "paused", ...FINISHING_STATES];

describeIfDb("the hierarchy guard, against Postgres", () => {
  const dbName = scratchDatabaseName("guard_hierarchy");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.item.deleteMany({});
  });

  let counter = 0;
  async function createItem(opts: {
    kind: "project" | "task" | "subtask";
    state: string;
    parentId?: string | null;
  }) {
    counter += 1;
    const id = `${opts.kind}-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: opts.parentId ?? null,
        kind: opts.kind,
        title: `Item ${counter}`,
        body: "body",
        state: opts.state as never,
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

  /** Minimal `ServiceContext`-shaped db handle over the raw Prisma client — no operation/runtime plumbing needed for guard-level tests. */
  function dbHandle(): TransactionHandle {
    return {
      $queryRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$queryRawUnsafe(query, ...values),
      $executeRawUnsafe: (query: string, ...values: unknown[]) =>
        prisma.$executeRawUnsafe(query, ...values),
    };
  }

  function newCtx() {
    return {
      db: dbHandle(),
      settings: defaultSnapshot(),
      caller: {},
      operation: "test",
    };
  }

  function transition(itemId: string, to: string) {
    const reg = new GuardRegistry();
    reg.register(hierarchyGuard);
    return applyTransition(newCtx(), { itemId, to }, reg);
  }

  function rehearse(itemId: string, to: string) {
    const reg = new GuardRegistry();
    reg.register(hierarchyGuard);
    return rehearseTransition(newCtx(), { itemId, to }, reg);
  }

  describe("criterion 1 — refuses to finish while a child is actionable", () => {
    it.each(FINISHING_STATES)(
      "rejects entering %s when a direct child is executing",
      async (to) => {
        const parent = await createItem({ kind: "task", state: "in_review" });
        await createItem({ kind: "subtask", state: "executing", parentId: parent });

        const error = await transition(parent, to).catch((e: unknown) => e);
        expect((error as { code?: string }).code).toBe("guard_rejected");
        expect((error as { guard?: string }).guard).toBe(
          "hierarchy.no_finish_with_actionable_child",
        );
        // The database, read directly, proves the refusal actually stopped
        // the write — not merely that the promise rejected.
        expect(await readState(parent)).toBe("in_review");
      },
    );

    it("names the guard's own id, not a generic rejection", async () => {
      const parent = await createItem({ kind: "task", state: "in_review" });
      await createItem({ kind: "subtask", state: "on_deck", parentId: parent });
      const error = (await transition(parent, "merged").catch((e: unknown) => e)) as {
        guard?: string;
        fields?: readonly string[];
      };
      expect(error.guard).toBe("hierarchy.no_finish_with_actionable_child");
      expect(error.fields).toContain("parent_id");
    });

    it("rejects when only ONE of several children is actionable — 'any', not 'all'", async () => {
      // Distinguishes `.some()` from `.every()`: with a single-child fixture
      // the two agree in every case, so a mutation from "any child
      // actionable" to "all children actionable" survives unless a test
      // actually mixes actionable and non-actionable siblings.
      const parent = await createItem({ kind: "task", state: "in_review" });
      await createItem({ kind: "subtask", state: "merged", parentId: parent });
      await createItem({ kind: "subtask", state: "wont_do", parentId: parent });
      await createItem({ kind: "subtask", state: "executing", parentId: parent });

      const error = await transition(parent, "merged").catch((e: unknown) => e);
      expect((error as { code?: string }).code).toBe("guard_rejected");
      expect(await readState(parent)).toBe("in_review");
    });
  });

  describe("criterion 2 — allows finishing when no child is actionable (no false positive)", () => {
    it("allows entering a completed state when the only child is already merged", async () => {
      const parent = await createItem({ kind: "task", state: "in_review" });
      await createItem({ kind: "subtask", state: "merged", parentId: parent });

      await transition(parent, "merged");
      expect(await readState(parent)).toBe("merged");
    });

    it("allows finishing when the only child is blocked", async () => {
      const parent = await createItem({ kind: "task", state: "in_review" });
      await createItem({ kind: "subtask", state: "blocked", parentId: parent });

      await transition(parent, "wont_do");
      expect(await readState(parent)).toBe("wont_do");
    });

    it("allows finishing when the only child is paused", async () => {
      const parent = await createItem({ kind: "task", state: "in_review" });
      await createItem({ kind: "subtask", state: "paused", parentId: parent });

      await transition(parent, "cancelled");
      expect(await readState(parent)).toBe("cancelled");
    });

    it("allows finishing an item with no children at all", async () => {
      const leaf = await createItem({ kind: "task", state: "in_review" });
      await transition(leaf, "research_done");
      expect(await readState(leaf)).toBe("research_done");
    });

    it("allows a non-finishing transition even with an actionable child — the guard only fires on entering a completed state", async () => {
      const parent = await createItem({ kind: "task", state: "in_review" });
      await createItem({ kind: "subtask", state: "executing", parentId: parent });

      // Moving to `blocked`, not a completed state — appliesTo is false, so
      // the guard has nothing to say and must not fire.
      await transition(parent, "blocked");
      expect(await readState(parent)).toBe("blocked");
    });
  });

  describe("criterion 3 — the actionable/non-actionable boundary, exhaustively", () => {
    it.each(ACTIONABLE_STATES)(
      "a child in '%s' blocks the parent from finishing",
      async (childState) => {
        const parent = await createItem({ kind: "task", state: "in_review" });
        await createItem({ kind: "subtask", state: childState, parentId: parent });
        const error = await transition(parent, "merged").catch((e: unknown) => e);
        expect((error as { code?: string }).code).toBe("guard_rejected");
        expect(await readState(parent)).toBe("in_review");
      },
    );

    it.each(NON_ACTIONABLE_STATES)(
      "a child in '%s' does NOT block the parent from finishing",
      async (childState) => {
        const parent = await createItem({ kind: "task", state: "in_review" });
        await createItem({ kind: "subtask", state: childState, parentId: parent });
        await transition(parent, "merged");
        expect(await readState(parent)).toBe("merged");
      },
    );

    it("the two sets above partition all twelve declared states with nothing left over", () => {
      // Pins the boundary to the vocabulary the state machine actually
      // declares (states.ts), not to a list this test invented — a state
      // added to ITEM_STATES without a decision about which side of the
      // boundary it falls on would fail here rather than pass silently.
      expect([...ACTIONABLE_STATES, ...NON_ACTIONABLE_STATES].sort()).toEqual(
        [...ITEM_STATES].sort(),
      );
    });
  });

  describe("criterion — depth: does the rule reach a grandchild", () => {
    it("a live grandchild blocks the grandparent, transitively via the blocked middle child", async () => {
      // Depth decision, stated: this guard queries **direct children only**
      // (see hierarchy.ts's `hasActionableChild` doc). It reaches a
      // grandchild transitively rather than directly — the middle child
      // cannot itself finish while ITS child (the grandchild) is
      // actionable, so the middle child stays actionable, which in turn
      // blocks the top-level parent. This test proves that chain actually
      // holds, not merely that a one-level check exists.
      const grandparent = await createItem({ kind: "task", state: "in_review" });
      const middle = await createItem({
        kind: "subtask",
        state: "in_review",
        parentId: grandparent,
      });
      await createItem({ kind: "subtask", state: "executing", parentId: middle });

      // The middle child cannot finish — its own child (the grandchild) is
      // actionable.
      const middleError = await transition(middle, "merged").catch((e: unknown) => e);
      expect((middleError as { code?: string }).code).toBe("guard_rejected");
      expect(await readState(middle)).toBe("in_review");

      // Because the middle child could not finish, it is still actionable
      // (`in_review`) — so the grandparent cannot finish either, even
      // though this guard only ever queried ONE level (grandparent →
      // middle), never the grandchild directly.
      const grandparentError = await transition(grandparent, "merged").catch((e: unknown) => e);
      expect((grandparentError as { code?: string }).code).toBe("guard_rejected");
      expect(await readState(grandparent)).toBe("in_review");
    });

    it("once the grandchild resolves and the middle child finishes, the grandparent can finish too", async () => {
      const grandparent = await createItem({ kind: "task", state: "in_review" });
      const middle = await createItem({
        kind: "subtask",
        state: "in_review",
        parentId: grandparent,
      });
      const grandchild = await createItem({
        kind: "subtask",
        state: "executing",
        parentId: middle,
      });

      // Resolve the grandchild first (the only legal order).
      await transition(grandchild, "wont_do");
      expect(await readState(grandchild)).toBe("wont_do");

      // Now the middle child's only child is non-actionable, so it can finish.
      await transition(middle, "merged");
      expect(await readState(middle)).toBe("merged");

      // And now the grandparent's only child (middle) is non-actionable too.
      await transition(grandparent, "merged");
      expect(await readState(grandparent)).toBe("merged");
    });

    it("what this guard's query does not see: it never issues a query scoped to more than one level of parentId", async () => {
      // Direct evidence for the depth claim, not just an outcome that could
      // coincidentally match a subtree-scanning implementation too: a
      // recording db handle proves every query this guard issues is scoped
      // to a single `parentId = $1` value, never a recursive/subtree shape.
      const grandparent = await createItem({ kind: "task", state: "in_review" });
      const middle = await createItem({
        kind: "subtask",
        state: "merged",
        parentId: grandparent,
      });
      await createItem({ kind: "subtask", state: "merged", parentId: middle });

      const seenQueries: string[] = [];
      const recording: TransactionHandle = {
        $queryRawUnsafe: (query: string, ...values: unknown[]) => {
          seenQueries.push(query);
          return prisma.$queryRawUnsafe(query, ...values);
        },
        $executeRawUnsafe: (query: string, ...values: unknown[]) =>
          prisma.$executeRawUnsafe(query, ...values),
      };
      const input: GuardInput = {
        item: {
          id: grandparent,
          kind: "task",
          state: "in_review",
          blockedReason: null,
          blockedOnType: null,
          blockedOnPersonId: null,
          unblockAt: null,
          pauseReason: null,
          resumeCondition: null,
          needsVisualReview: false,
          mergeAuthority: "needs_approval",
        },
        from: "in_review",
        to: "merged",
        fields: {},
        db: recording,
        settings: defaultSnapshot(),
      };
      const result = await hierarchyGuard.check(input);
      expect(result.ok).toBe(true);
      expect(seenQueries).toHaveLength(1);
      expect(seenQueries[0]).toMatch(/"parentId"\s*=\s*\$1/);
      expect(seenQueries[0]).not.toMatch(/RECURSIVE/i);
    });
  });

  describe("criterion 4 — registers into the existing GuardRegistry, no parallel mechanism", () => {
    it("is retrievable from a GuardRegistry by its own id, and applicable only to entering a completed state", () => {
      const reg = new GuardRegistry();
      reg.register(hierarchyGuard);
      expect(reg.has("hierarchy.no_finish_with_actionable_child")).toBe(true);

      for (const finishing of FINISHING_STATES) {
        expect(hierarchyGuard.appliesTo("in_review", finishing)).toBe(true);
      }
      for (const notFinishing of ["blocked", "paused", "executing", "on_deck"]) {
        expect(hierarchyGuard.appliesTo("in_review", notFinishing)).toBe(false);
      }
    });

    it("does not fire for a project — the state machine refuses a project before any guard runs", async () => {
      // Belt-and-braces on the interaction this row was told to verify
      // explicitly: `transition.ts`'s `evaluate()` throws
      // `ProjectHasNoStateError` before `runGuards` is ever called, for any
      // item whose `kind` is `project` — so this guard is never asked
      // about one. Proven here by calling `applyTransition` directly
      // against a project row with the real (unfiltered) `guardRegistry`
      // singleton, which has this guard registered via the `@/lib/service`
      // barrel import at the top of this file.
      const project = await createItem({ kind: "project", state: "someday" });
      const ctx = {
        db: dbHandle(),
        settings: defaultSnapshot(),
        caller: {},
        operation: "test",
      };
      const error = await applyTransition(ctx, { itemId: project, to: "merged" }).catch(
        (e: unknown) => e,
      );
      expect((error as { name?: string }).name).toBe("ProjectHasNoStateError");
      expect(await readState(project)).toBe("someday");
    });
  });

  describe("rehearsal", () => {
    it("reports the rejection without writing anything", async () => {
      const parent = await createItem({ kind: "task", state: "in_review" });
      await createItem({ kind: "subtask", state: "executing", parentId: parent });

      const outcome = await rehearse(parent, "merged");
      expect(outcome.allowed).toBe(false);
      expect(outcome.rejection?.guard).toBe("hierarchy.no_finish_with_actionable_child");
      expect(await readState(parent)).toBe("in_review");
    });
  });
});
