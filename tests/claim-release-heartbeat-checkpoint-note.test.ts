// Service operations for MILESTONES.md #29 (claim, release, heartbeat,
// checkpoint, note) against a real Postgres. See tests/items-operations.test.ts
// and tests/service-transaction-db.test.ts for why these need a real
// database rather than a modelled handle: rollback and constraint behaviour
// are things only Postgres can prove.
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

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("claim / release / heartbeat / checkpoint / note — against Postgres", () => {
  const dbName = scratchDatabaseName("claim_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let itemCounter = 0;

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    await prisma.area.create({ data: { id: "test-area", displayName: "Test area" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  /** Seeds one fresh item per call so cases don't share claim state. */
  async function seedItem(): Promise<string> {
    itemCounter += 1;
    const id = `item-${itemCounter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state: "on_deck",
        originType: "auto",
        area: "test-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  function claimInput(itemId: string, overrides: Record<string, unknown> = {}) {
    return {
      itemId,
      role: "builder",
      holderType: "agent",
      holderId: "crew-member",
      sessionId: "s1",
      machine: "laptop",
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // AC1: claim
  // -------------------------------------------------------------------------

  describe("claim", () => {
    it("claims an item and returns the assignment", async () => {
      const itemId = await seedItem();
      const assignment = (await runtime.call("claim", claimInput(itemId))) as {
        itemId: string;
        sessionId: string;
        role: string;
      };
      expect(assignment.itemId).toBe(itemId);
      expect(assignment.sessionId).toBe("s1");
      expect(assignment.role).toBe("builder");
    });

    it("refuses to claim a non-existent item with a typed not_found (not a raw FK violation)", async () => {
      const error = await runtime
        .call("claim", claimInput("no-such-item"))
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
      expect((error as { fields: string[] }).fields).toEqual(["itemId"]);
    });

    it("routes a bad role/roleCustom pairing through the OPERATION, end to end — closes the #23 coverage gap", async () => {
      // Row #23's reviewer found: nothing asserted `claimItem` actually
      // calls `assertRoleCustom` through a real caller path — every unit
      // test in tests/claims.test.ts invokes `assertRoleCustom` directly.
      // This drives a bad pairing through the SERVICE OPERATION, which is
      // the thing every real adapter (HTTP now, MCP/CLI later) actually
      // calls. Mutation evidence: deleting the `assertRoleCustom(...)` call
      // inside claim.ts's delegation to claimItem — or, if that call were
      // ever removed from claims.ts's own claimItem body — would make this
      // pass with no rejection at all, which is exactly the gap described.
      const itemId = await seedItem();
      const error = await runtime
        .call("claim", claimInput(itemId, { role: "custom", roleCustom: null }))
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("guard_rejected");
      expect((error as { guard: string }).guard).toBe("claims.custom_role_needs_name");
    });

    it("routes the QUIET direction of the same pairing through the operation too", async () => {
      // The other half of assertRoleCustom's rejection — a roleCustom named
      // alongside a REAL role. Both directions must survive the operation
      // boundary, not just the guard unit tests.
      const itemId = await seedItem();
      const error = await runtime
        .call("claim", claimInput(itemId, { role: "builder", roleCustom: "release-manager" }))
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("guard_rejected");
      expect((error as { guard: string }).guard).toBe("claims.custom_role_needs_name");
    });

    it("accepts a well-formed custom role through the operation", async () => {
      const itemId = await seedItem();
      const assignment = (await runtime.call(
        "claim",
        claimInput(itemId, { role: "custom", roleCustom: "release-manager" }),
      )) as { role: string; roleCustom: string };
      expect(assignment.role).toBe("custom");
      expect(assignment.roleCustom).toBe("release-manager");
    });

    it("a second orchestrator claim through the operation is refused as a conflict", async () => {
      const itemId = await seedItem();
      await runtime.call("claim", claimInput(itemId, { role: "orchestrator", sessionId: "s1" }));
      const error = await runtime
        .call(
          "claim",
          claimInput(itemId, { role: "orchestrator", sessionId: "s2", rootSessionId: "s1" }),
        )
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("conflict");
    });

    it("rejects malformed input (missing required field) as invalid_input", async () => {
      const itemId = await seedItem();
      const error = await runtime
        .call("claim", { itemId, role: "builder" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
    });

    it("passes every optional field through to the assignment, not just the required ones", async () => {
      // Mutation evidence: claim.ts delegates to claimItem with each
      // optional field written `input.x ?? null`. A mutant that changes any
      // one of those to `input.x && null` still typechecks and passes every
      // OTHER test here (all of which omit the optional fields, so `?? null`
      // and `&& null` agree on undefined), but it silently drops a real,
      // truthy value — exactly what this test exists to catch.
      const itemId = await seedItem();
      const assignment = (await runtime.call(
        "claim",
        claimInput(itemId, {
          parentSessionId: "parent-s1",
          pid: 4242,
          branch: "feature/x",
          worktree: "/tmp/wt-x",
          model: "claude-sonnet-5",
          effort: "medium",
        }),
      )) as {
        parentSessionId: string | null;
        pid: number | null;
        branch: string | null;
        worktree: string | null;
        model: string | null;
        effort: string | null;
      };
      expect(assignment.parentSessionId).toBe("parent-s1");
      expect(assignment.pid).toBe(4242);
      expect(assignment.branch).toBe("feature/x");
      expect(assignment.worktree).toBe("/tmp/wt-x");
      expect(assignment.model).toBe("claude-sonnet-5");
      expect(assignment.effort).toBe("medium");
    });
  });

  // -------------------------------------------------------------------------
  // AC2: release
  // -------------------------------------------------------------------------

  describe("release", () => {
    it("releases the caller's own live assignment and stamps releasedAt", async () => {
      const itemId = await seedItem();
      await runtime.call("claim", claimInput(itemId));

      const released = (await runtime.call("release", { itemId, sessionId: "s1" })) as {
        releasedAt: string | null;
        sessionId: string;
      };
      expect(released.sessionId).toBe("s1");
      expect(released.releasedAt).not.toBeNull();

      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "Assignment" WHERE "itemId" = $1 AND "releasedAt" IS NULL`,
        itemId,
      );
      expect(Number(rows[0]?.count ?? 1n)).toBe(0);
    });

    it("appends a release event in the same transaction, with the assignment's role and holder in the payload", async () => {
      const itemId = await seedItem();
      const assignment = (await runtime.call(
        "claim",
        claimInput(itemId, { role: "reviewer", holderId: "crew-member" }),
      )) as { id: string };
      await runtime.call("release", { itemId, sessionId: "s1" });

      const events = await prisma.event.findMany({ where: { itemId, type: "release" } });
      expect(events).toHaveLength(1);
      expect(events[0]?.assignmentId).toBe(assignment.id);
      // Mutation evidence: the payload object literal at release.ts's
      // appendEvent call (`{ assignmentId, role, holderId }`) — a mutant
      // that replaced it with `{}` would leave `assignmentId` (asserted
      // above, via the top-level column) untouched but silently drop
      // `role`/`holderId` from the payload, which nothing else here checks.
      expect(events[0]?.payload).toEqual({
        assignmentId: assignment.id,
        role: "reviewer",
        holderId: "crew-member",
      });
    });

    it("refuses to release a session that holds nothing on this item", async () => {
      const itemId = await seedItem();
      const error = await runtime
        .call("release", { itemId, sessionId: "ghost" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("conflict");
      expect((error as { fields: string[] }).fields).toEqual(["itemId", "sessionId"]);
    });

    it("refuses to release an ALREADY-released assignment (double release)", async () => {
      const itemId = await seedItem();
      await runtime.call("claim", claimInput(itemId));
      await runtime.call("release", { itemId, sessionId: "s1" });

      const error = await runtime
        .call("release", { itemId, sessionId: "s1" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("conflict");
    });

    it("releasing one session's row does not touch a crewmate's row on the same item", async () => {
      // Releases the SECOND-claimed session (s2) and asserts the FIRST
      // (s1) is the one left live. This ordering is deliberate: a query
      // that dropped the `sessionId` filter and kept only `itemId` +
      // `releasedAt IS NULL` with `LIMIT 1` would, on an unindexed scan,
      // tend to return rows in insertion order — releasing s1 in that
      // broken query would still leave s2 live and pass a test that
      // released s1. Releasing s2 here means a session-filter-less query
      // would release s1 (the wrong, first-inserted row) and leave s2 live
      // instead of s1 — an outcome this test's final assertion catches.
      const itemId = await seedItem();
      await runtime.call("claim", claimInput(itemId, { role: "orchestrator", sessionId: "s1" }));
      await runtime.call(
        "claim",
        claimInput(itemId, { role: "builder", sessionId: "s2", rootSessionId: "s1" }),
      );

      await runtime.call("release", { itemId, sessionId: "s2" });

      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "Assignment" WHERE "itemId" = $1 AND "releasedAt" IS NULL`,
        itemId,
      );
      expect(Number(rows[0]?.count ?? 0n)).toBe(1);
      const live = await prisma.assignment.findFirst({ where: { itemId, releasedAt: null } });
      expect(live?.sessionId).toBe("s1");
    });

    it("a session may re-claim the same item after releasing", async () => {
      const itemId = await seedItem();
      await runtime.call("claim", claimInput(itemId));
      await runtime.call("release", { itemId, sessionId: "s1" });

      const second = (await runtime.call("claim", claimInput(itemId, { role: "reviewer" }))) as {
        role: string;
      };
      expect(second.role).toBe("reviewer");
    });
  });

  // -------------------------------------------------------------------------
  // AC3: heartbeat
  // -------------------------------------------------------------------------

  describe("heartbeat", () => {
    it("bumps lastActive on the caller's live assignment", async () => {
      const itemId = await seedItem();
      const claimed = (await runtime.call("claim", claimInput(itemId))) as {
        id: string;
        lastActive: Date;
      };

      // Force the clock forward at the row so the UPDATE's CURRENT_TIMESTAMP
      // is provably later than the value the claim wrote, rather than
      // depending on wall-clock timing being coarse enough to differ.
      await prisma.assignment.update({
        where: { id: claimed.id },
        data: { lastActive: new Date(0) },
      });

      const beat = (await runtime.call("heartbeat", { itemId, sessionId: "s1" })) as {
        lastActive: Date;
        id: string;
      };
      expect(beat.id).toBe(claimed.id);
      expect(new Date(beat.lastActive).getTime()).toBeGreaterThan(0);
    });

    it("does not append any event — a heartbeat is a liveness signal, not a ledger entry", async () => {
      const itemId = await seedItem();
      await runtime.call("claim", claimInput(itemId));
      const before = await prisma.event.count({ where: { itemId } });

      await runtime.call("heartbeat", { itemId, sessionId: "s1" });

      const after = await prisma.event.count({ where: { itemId } });
      expect(after).toBe(before);
    });

    it("refuses a heartbeat from a session holding nothing live on this item", async () => {
      const itemId = await seedItem();
      const error = await runtime
        .call("heartbeat", { itemId, sessionId: "ghost" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("conflict");
      expect((error as { fields: string[] }).fields).toEqual(["itemId", "sessionId"]);
    });

    it("refuses a heartbeat after the session has released", async () => {
      const itemId = await seedItem();
      await runtime.call("claim", claimInput(itemId));
      await runtime.call("release", { itemId, sessionId: "s1" });

      const error = await runtime
        .call("heartbeat", { itemId, sessionId: "s1" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("conflict");
    });
  });

  // -------------------------------------------------------------------------
  // AC4: checkpoint (write path)
  // -------------------------------------------------------------------------

  describe("checkpoint", () => {
    it("appends a checkpoint event with body and assignmentId set", async () => {
      const itemId = await seedItem();
      const assignment = (await runtime.call("claim", claimInput(itemId))) as { id: string };

      const event = (await runtime.call("checkpoint", {
        itemId,
        sessionId: "s1",
        body: "Tried X, ruled out Y, next is Z.",
      })) as { id: bigint; txId: bigint; ts: Date };
      expect(event.id).toBeDefined();

      const rows = await prisma.event.findMany({ where: { itemId, type: "checkpoint" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.assignmentId).toBe(assignment.id);
      expect(rows[0]?.body).toBe("Tried X, ruled out Y, next is Z.");
      // Payload is deliberately empty (SCHEMA.md §3): prose in body, agent in assignmentId.
      expect(rows[0]?.payload).toEqual({});
    });

    it("rejects an empty checkpoint body", async () => {
      const itemId = await seedItem();
      await runtime.call("claim", claimInput(itemId));
      const error = await runtime
        .call("checkpoint", { itemId, sessionId: "s1", body: "   " })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
    });

    it("refuses a checkpoint from a session holding no live assignment on this item", async () => {
      const itemId = await seedItem();
      const error = await runtime
        .call("checkpoint", { itemId, sessionId: "ghost", body: "x" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("conflict");
      expect((error as { fields: string[] }).fields).toEqual(["itemId", "sessionId"]);
    });

    it("two agents on the same item get INDEPENDENT checkpoint history (per-agent, not just per-item)", async () => {
      // SCHEMA.md §4: "Per agent, not just per item — assignment_id carries
      // that, so a stalled builder still has its own resume point." This is
      // the case that would break if checkpoint ever stopped requiring (and
      // recording) the caller's own assignment.
      const itemId = await seedItem();
      const orchestrator = (await runtime.call(
        "claim",
        claimInput(itemId, { role: "orchestrator", sessionId: "s1" }),
      )) as { id: string };
      const builder = (await runtime.call(
        "claim",
        claimInput(itemId, { role: "builder", sessionId: "s2", rootSessionId: "s1" }),
      )) as { id: string };

      await runtime.call("checkpoint", { itemId, sessionId: "s1", body: "orchestrator note" });
      await runtime.call("checkpoint", { itemId, sessionId: "s2", body: "builder note" });

      const orchestratorCheckpoints = await prisma.event.findMany({
        where: { itemId, type: "checkpoint", assignmentId: orchestrator.id },
      });
      const builderCheckpoints = await prisma.event.findMany({
        where: { itemId, type: "checkpoint", assignmentId: builder.id },
      });
      expect(orchestratorCheckpoints).toHaveLength(1);
      expect(orchestratorCheckpoints[0]?.body).toBe("orchestrator note");
      expect(builderCheckpoints).toHaveLength(1);
      expect(builderCheckpoints[0]?.body).toBe("builder note");
    });
  });

  // -------------------------------------------------------------------------
  // AC4: note (write path)
  // -------------------------------------------------------------------------

  describe("note", () => {
    it("appends a note event with the body, needing no live assignment", async () => {
      const itemId = await seedItem();
      const event = (await runtime.call("note", {
        itemId,
        body: "A remark from someone who never claimed this.",
      })) as { id: bigint };
      expect(event.id).toBeDefined();

      const rows = await prisma.event.findMany({ where: { itemId, type: "note" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe("A remark from someone who never claimed this.");
      expect(rows[0]?.assignmentId).toBeNull();
      // No caller.actor and no explicit actorType → system, per the schema default.
      expect(rows[0]?.actorType).toBe("system");
    });

    it("attributes to the caller's live assignment when sessionId names one that holds this item", async () => {
      const itemId = await seedItem();
      const assignment = (await runtime.call("claim", claimInput(itemId))) as {
        id: string;
        holderId: string;
      };

      await runtime.call("note", { itemId, sessionId: "s1", body: "from the builder" });

      const rows = await prisma.event.findMany({ where: { itemId, type: "note" } });
      expect(rows[0]?.assignmentId).toBe(assignment.id);
      expect(rows[0]?.actorType).toBe("agent");
      expect(rows[0]?.actorId).toBe(assignment.holderId);
    });

    it("an explicit actorType/actorId is honoured even when sessionId names a live holder", async () => {
      const itemId = await seedItem();
      await runtime.call("claim", claimInput(itemId));

      await runtime.call("note", {
        itemId,
        sessionId: "s1",
        actorType: "person",
        actorId: "user-a",
        body: "a human overriding the attribution",
      });

      const rows = await prisma.event.findMany({ where: { itemId, type: "note" } });
      expect(rows[0]?.actorType).toBe("person");
      expect(rows[0]?.actorId).toBe("user-a");
    });

    it("a sessionId that holds nothing live still succeeds — a note needs no claim", async () => {
      // Mutation evidence: `sessionId: input.sessionId ?? null` on the
      // event's actor — a mutant that changed `??` to `&&` still passes an
      // undefined-sessionId call (every OTHER test path) but silently drops
      // a real sessionId here, since `"unrelated-session" && null` is
      // `null`. The sessionId assertion below is what catches that.
      const itemId = await seedItem();
      const event = (await runtime.call("note", {
        itemId,
        sessionId: "unrelated-session",
        body: "still allowed",
      })) as { id: bigint };
      expect(event.id).toBeDefined();

      const rows = await prisma.event.findMany({ where: { itemId, type: "note" } });
      expect(rows[0]?.assignmentId).toBeNull();
      expect(rows[0]?.sessionId).toBe("unrelated-session");
    });

    it("refuses a note on a non-existent item as not_found", async () => {
      const error = await runtime
        .call("note", { itemId: "no-such-item", body: "x" })
        .catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("not_found");
      expect((error as { fields: string[] }).fields).toEqual(["itemId"]);
    });

    it("rejects an empty note body", async () => {
      const itemId = await seedItem();
      const error = await runtime.call("note", { itemId, body: "" }).catch((e: unknown) => e);
      expect((error as { code: string }).code).toBe("invalid_input");
    });
  });
});
