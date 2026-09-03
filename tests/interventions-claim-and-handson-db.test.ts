// I13's claim signal and I14's hands-on reading, against a real Postgres —
// `docs/plans/INTERVENTIONS.md` I13, I14.
//
// ── Why this file exists, stated as the failure it exists to catch ─────
//
// The predicates for both entries are pure and are tested as such: given a
// context, do they reach the right verdict. That is worth having and it
// proves nothing about whether the context is ever *assembled* correctly,
// because the assembler is the half that talks to the database.
//
// Hand-mutation demonstrated the gap rather than theorising about it. Four
// mutants of `assembleContext` survived the entire unit suite:
//
//   - Dropping `holdsClaim: false` from the no-claim path. This **silently
//     disarms I13 completely** — the field stays absent, the predicate reads
//     absent as "nobody asked", and the entry never fires again. Nothing in
//     the suite noticed, and nothing in behaviour would either: the guard
//     simply stops existing.
//   - Dropping the `role === "orchestrator"` gate on the window read, which
//     is the gate that keeps I14 affordable.
//   - Comparing the sample against `0` instead of the minimum, so a
//     two-call session reports a real reading instead of `unknown`.
//   - An off-by-one on the edit threshold.
//
// Each is invisible from the outside, which is exactly the class of defect
// a text-level assertion cannot reach. So the semantics are pinned here by
// running the real queries against real rows.
//
// Skips without TEST_DATABASE_URL, like every other database-backed file
// here; CI's database job runs it, and `check:db-gated:require` fails there
// if the URL is missing rather than skipping silently.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { assembleContext } from "@/lib/interventions/context";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("I13 and I14 context assembly — against Postgres", () => {
  const dbName = scratchDatabaseName("interventions_claim_handson");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    await prisma.repo.create({ data: { id: "repo-a", displayName: "repo-a" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.toolCall.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  let counter = 0;

  async function createItem(): Promise<string> {
    counter += 1;
    const id = `item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Item ${counter}`,
        body: "body",
        state: "executing" as never,
        originType: "person",
        area: "web",
        repo: "repo-a",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function claim(options: {
    sessionId: string;
    itemId: string;
    role?: "orchestrator" | "builder" | "reviewer";
  }): Promise<void> {
    await prisma.assignment.create({
      data: {
        itemId: options.itemId,
        role: (options.role ?? "builder") as never,
        holderType: "agent",
        holderId: options.sessionId,
        sessionId: options.sessionId,
        rootSessionId: options.sessionId,
        machine: "desktop",
        liveness: "running" as never,
      },
    });
  }

  /** `count` tool calls on a session, `edits` of which are file edits. */
  async function recordCalls(sessionId: string, count: number, edits: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await prisma.toolCall.create({
        data: {
          sessionId,
          tool: index < edits ? "Edit" : "Read",
          command: null,
          paths: [],
          ts: new Date(Date.now() + index * 1000),
        },
      });
    }
  }

  const handsOn = { minimumSample: 20, editThreshold: 12, window: 40 };

  describe("I13 — whether this session holds anything at all", () => {
    it("reports holdsClaim false for a session with no claim, on a commit", async () => {
      // **The mutant this kills is the worst of the four.** Returning the
      // bare base context here leaves `holdsClaim` absent, the predicate
      // reads absent as "nobody asked", and I13 never fires again — a guard
      // that silently stops existing rather than failing.
      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-unclaimed",
        tool: "Bash",
        command: "git commit -m 'the work'",
      });

      expect(context.holdsClaim).toBe(false);
      // Distinct from the field merely being absent, which is what a call
      // the gate never looked up produces.
      expect("holdsClaim" in context).toBe(true);
      expect(context.itemId).toBeUndefined();
    });

    it("reports holdsClaim true, and the item, for a session that holds one", async () => {
      const item = await createItem();
      await claim({ sessionId: "s-claimed", itemId: item });

      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-claimed",
        tool: "Bash",
        command: "git commit -m 'the work'",
      });

      expect(context.holdsClaim).toBe(true);
      expect(context.itemId).toBe(item);
    });

    it("leaves holdsClaim absent for a command that asks nothing of the claim", async () => {
      // The other half of the distinction: an `ls` never looks, so the
      // honest answer is "not known" rather than `false`. A predicate that
      // read this as false would fire on nearly every call in the system.
      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-unclaimed",
        tool: "Bash",
        command: "ls -la",
      });

      expect("holdsClaim" in context).toBe(false);
    });

    it("reports the role the claim was taken in", async () => {
      const item = await createItem();
      await claim({ sessionId: "s-orch", itemId: item, role: "orchestrator" });

      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-orch",
        tool: "Bash",
        command: "git commit -m 'x'",
      });

      expect(context.claimedRole).toBe("orchestrator");
    });
  });

  describe("I14 — the hands-on reading", () => {
    it("reads elevated for an orchestrator over the edit threshold", async () => {
      const item = await createItem();
      await claim({ sessionId: "s-orch", itemId: item, role: "orchestrator" });
      await recordCalls("s-orch", 25, 15);

      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-orch",
        tool: "Edit",
        phase: "post",
        handsOn,
      });

      expect(context.handsOnWork).toBe("elevated");
    });

    it("reads normal for an orchestrator that is mostly reading", async () => {
      const item = await createItem();
      await claim({ sessionId: "s-orch", itemId: item, role: "orchestrator" });
      // The briefing case the entry is written to tolerate: a wide read and
      // a few edits is an orchestrator doing its job, not becoming a builder.
      await recordCalls("s-orch", 30, 3);

      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-orch",
        tool: "Edit",
        phase: "post",
        handsOn,
      });

      expect(context.handsOnWork).toBe("normal");
    });

    it("reads unknown below the minimum sample, however lopsided the calls", async () => {
      // Kills the `rows.length < 0` mutant. Every call in this fixture is an
      // edit, so a build that compared against the wrong bound would answer
      // `elevated` on a five-call session and nudge every orchestrator on
      // its opening moves.
      const item = await createItem();
      await claim({ sessionId: "s-orch", itemId: item, role: "orchestrator" });
      await recordCalls("s-orch", 5, 5);

      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-orch",
        tool: "Edit",
        phase: "post",
        handsOn,
      });

      expect(context.handsOnWork).toBe("unknown");
    });

    it("treats the edit threshold as inclusive", async () => {
      // Kills the `>=` to `>` mutant. Exactly at the threshold, which is the
      // one sample where the two spellings disagree.
      const item = await createItem();
      await claim({ sessionId: "s-orch", itemId: item, role: "orchestrator" });
      await recordCalls("s-orch", 25, handsOn.editThreshold);

      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-orch",
        tool: "Edit",
        phase: "post",
        handsOn,
      });

      expect(context.handsOnWork).toBe("elevated");
    });

    it("does not read the window for a builder, however much it edits", async () => {
      // **The cost gate.** Dropping it is invisible in behaviour — I14's
      // predicate would still decline on the role — and shows up only as a
      // query on every builder's file edits. Asserted as the field being
      // absent, which is the observable consequence of the read not
      // happening.
      const item = await createItem();
      await claim({ sessionId: "s-builder", itemId: item, role: "builder" });
      await recordCalls("s-builder", 30, 25);

      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-builder",
        tool: "Edit",
        phase: "post",
        handsOn,
      });

      expect(context.handsOnWork).toBeUndefined();
    });

    it("does not read the window on a pre event", async () => {
      const item = await createItem();
      await claim({ sessionId: "s-orch", itemId: item, role: "orchestrator" });
      await recordCalls("s-orch", 30, 25);

      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-orch",
        tool: "Edit",
        phase: "pre",
        handsOn,
      });

      expect(context.handsOnWork).toBeUndefined();
    });

    it("answers unknown when no thresholds were supplied", async () => {
      // A count compared against a number nobody chose is not a finding, so
      // the reading withholds rather than inventing a default.
      const item = await createItem();
      await claim({ sessionId: "s-orch", itemId: item, role: "orchestrator" });
      await recordCalls("s-orch", 30, 25);

      const context = await assembleContext({
        db: prisma as never,
        sessionId: "s-orch",
        tool: "Edit",
        phase: "post",
      });

      expect(context.handsOnWork).toBe("unknown");
    });
  });
});
