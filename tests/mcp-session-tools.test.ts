// MCP session tools — claim, release, heartbeat, checkpoint, note
// (MILESTONES.md #33, SCHEMA.md §18).
//
// Every one of these five is already exposed as an MCP tool with no code of
// its own: `createMcpServer` (`src/lib/mcp/server.ts`, MILESTONES.md #30)
// derives one tool per *registered service operation*, and `claim` /
// `release` / `heartbeat` / `checkpoint` / `note` were registered by
// MILESTONES.md #29. `tests/mcp-server.test.ts` and `tests/mcp-http.test.ts`
// already prove that derivation and that rendering generically, against a
// stub service call. What neither of those files does — and what this one
// exists to do — is drive these five operations' own real, DB-backed
// behaviour through the real MCP transport: the atomic claim race, a
// released or expired lease, and the two write paths that turn out to need
// their own coverage (see "the checkpoint/note regression" below).
//
// Real Postgres throughout, for the same reason `tests/claims.test.ts` and
// `tests/claim-release-heartbeat-checkpoint-note.test.ts` need one: the
// property under test — Postgres serialising two concurrent inserts on a
// partial unique index, and a liveness sweep actually releasing a row — is
// not something an in-memory double can decide correctly by construction.
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { ServiceRuntime, prismaTransactionRunner, type TransactionHandle } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { sweepLiveness } from "@/lib/liveness";
import type { ServiceCall } from "@/lib/mcp";
import { handleMcpRequest } from "@/lib/mcp/http";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

/**
 * How many times the concurrent-claim race runs. `tests/claims.test.ts`
 * already proves the underlying atomicity with 25 rounds at the
 * `claimItem` level — this file isn't re-establishing that, it's proving
 * the same guarantee survives being reached through the extra layers MCP
 * adds (a fresh `McpServer` and transport per request, the tool dispatch,
 * the result rendering). Fewer rounds than the lower-level suite, because
 * each one here is a full simulated HTTP request/response, not a bare
 * `claimItem` call — enough rounds that "it didn't happen this time" isn't
 * a believable read of a green run, asserted explicitly so a later edit
 * can't quietly drop it to one.
 */
const MCP_RACE_ROUNDS = 10;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface CallToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly text: string;
}

describeIfDb("MCP session tools, over the real transport and a real database", () => {
  const dbName = scratchDatabaseName("mcp_session_tools");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let itemCounter = 0;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
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

  function realRuntimeCall(): ServiceCall {
    return (name, input, options) => runtime.call(name, input, options);
  }

  /**
   * Calls one MCP tool over the real, stateless HTTP wiring
   * (`handleMcpRequest`) — the same entry point `src/app/api/mcp/route.ts`
   * serves in production — with no prior `initialize`. `mcp-http.test.ts`'s
   * "stateless" cases already establish that a stateless server answers a
   * `tools/call` with no preceding handshake, which is what lets two of
   * these run genuinely concurrently via `Promise.all` without coordinating
   * a shared session first.
   */
  async function callTool(name: string, args: unknown): Promise<CallToolResult> {
    const response = await handleMcpRequest(
      new Request("http://mcp.test/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      realRuntimeCall(),
    );
    const body = (await response.json()) as {
      result: {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content: { text: string }[];
      };
    };
    return {
      isError: body.result.isError,
      structuredContent: body.result.structuredContent,
      text: body.result.content[0]?.text ?? "",
    };
  }

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

  // ---------------------------------------------------------------------
  // claim
  // ---------------------------------------------------------------------

  describe("claim", () => {
    it("claims an item through the MCP tool and returns the real assignment", async () => {
      const itemId = await seedItem();
      const result = await callTool("claim", claimInput(itemId));
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        itemId,
        sessionId: "s1",
        role: "builder",
      });
    });

    it(`${MCP_RACE_ROUNDS} rounds: two genuinely concurrent MCP claim calls — exactly one wins each round`, async () => {
      for (let round = 0; round < MCP_RACE_ROUNDS; round += 1) {
        const itemId = await seedItem();
        // Both claims share one root session (the same crew) so the ONLY
        // thing that can decide the race is the partial unique index this
        // test means to exercise (`claims.ts`'s rule 1, "one live
        // orchestrator per item"). With two DIFFERENT root sessions the
        // app-level crew check (`assertSameCrew`, rule 3 — a check-then-
        // write that runs ahead of the insert) can also produce a refusal,
        // and which of the two rules answers first would then depend on
        // exactly how the two requests interleave — the race this test
        // would then be at the mercy of is the wrong one.
        const rootSessionId = `race-root-${round}`;
        const [first, second] = await Promise.all([
          callTool(
            "claim",
            claimInput(itemId, {
              role: "orchestrator",
              sessionId: `race-a-${round}`,
              rootSessionId,
            }),
          ),
          callTool(
            "claim",
            claimInput(itemId, {
              role: "orchestrator",
              sessionId: `race-b-${round}`,
              rootSessionId,
            }),
          ),
        ]);

        const winners = [first, second].filter((outcome) => !outcome.isError);
        const losers = [first, second].filter((outcome) => outcome.isError);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(losers[0]?.structuredContent).toMatchObject({ code: "conflict" });

        // The database, not just the MCP rendering, agrees there is exactly
        // one live orchestrator on this item — the property that would be
        // false if the two calls' transactions had somehow both landed.
        const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT COUNT(*)::bigint AS "count" FROM "Assignment" WHERE "itemId" = $1 AND "releasedAt" IS NULL`,
          itemId,
        );
        expect(Number(rows[0]?.count ?? 0n)).toBe(1);
      }
    }, 30_000);

    it("a sequential second orchestrator claim through MCP is refused with the real conflict shape", async () => {
      const itemId = await seedItem();
      await callTool(
        "claim",
        claimInput(itemId, { role: "orchestrator", sessionId: "s1", rootSessionId: "s1" }),
      );
      // Same root session as the first claim (same crew) — a second, real
      // crew reading the same item back would be refused by the crew check
      // (`guard_rejected`) before ever reaching the index this asserts on.
      const second = await callTool(
        "claim",
        claimInput(itemId, { role: "orchestrator", sessionId: "s2", rootSessionId: "s1" }),
      );
      expect(second.isError).toBe(true);
      expect(second.structuredContent).toMatchObject({
        code: "conflict",
        fields: ["itemId", "role"],
      });
    });

    it("rejects a malformed claim (missing required fields) as invalid_input, through MCP", async () => {
      const itemId = await seedItem();
      const result = await callTool("claim", { itemId, role: "builder" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "invalid_input" });
    });
  });

  // ---------------------------------------------------------------------
  // release
  // ---------------------------------------------------------------------

  describe("release", () => {
    it("releases through the MCP tool and stamps releasedAt", async () => {
      const itemId = await seedItem();
      await callTool("claim", claimInput(itemId));
      const result = await callTool("release", { itemId, sessionId: "s1" });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.releasedAt).not.toBeNull();

      const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*)::bigint AS "count" FROM "Assignment" WHERE "itemId" = $1 AND "releasedAt" IS NULL`,
        itemId,
      );
      expect(Number(rows[0]?.count ?? 1n)).toBe(0);
    });

    it("a double release through MCP is refused as a conflict", async () => {
      const itemId = await seedItem();
      await callTool("claim", claimInput(itemId));
      await callTool("release", { itemId, sessionId: "s1" });
      const second = await callTool("release", { itemId, sessionId: "s1" });
      expect(second.isError).toBe(true);
      expect(second.structuredContent).toMatchObject({
        code: "conflict",
        fields: ["itemId", "sessionId"],
      });
    });

    it("releasing through MCP refuses a session that holds nothing on the item", async () => {
      const itemId = await seedItem();
      const result = await callTool("release", { itemId, sessionId: "ghost" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: "conflict",
        fields: ["itemId", "sessionId"],
      });
    });
  });

  // ---------------------------------------------------------------------
  // heartbeat
  // ---------------------------------------------------------------------

  describe("heartbeat", () => {
    it("bumps lastActive through the MCP tool", async () => {
      const itemId = await seedItem();
      const claimed = await callTool("claim", claimInput(itemId));
      const assignmentId = (claimed.structuredContent as { id: string }).id;
      await prisma.assignment.update({
        where: { id: assignmentId },
        data: { lastActive: new Date(0) },
      });

      const result = await callTool("heartbeat", { itemId, sessionId: "s1" });
      expect(result.isError).toBeFalsy();
      const lastActive = (result.structuredContent as { lastActive: string }).lastActive;
      expect(new Date(lastActive).getTime()).toBeGreaterThan(0);
    });

    it("a heartbeat through MCP for a session with no live assignment is refused as a conflict", async () => {
      const itemId = await seedItem();
      const result = await callTool("heartbeat", { itemId, sessionId: "ghost" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: "conflict",
        fields: ["itemId", "sessionId"],
      });
    });

    it("a heartbeat through MCP after release is refused — an ended lease cannot be kept alive", async () => {
      const itemId = await seedItem();
      await callTool("claim", claimInput(itemId));
      await callTool("release", { itemId, sessionId: "s1" });
      const result = await callTool("heartbeat", { itemId, sessionId: "s1" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "conflict" });
    });
  });

  // ---------------------------------------------------------------------
  // checkpoint — also the regression coverage for the bigint rendering fix
  // (src/lib/mcp/result.ts). Before that fix, this call succeeded against
  // the database and was reported to the caller as a failure.
  // ---------------------------------------------------------------------

  describe("checkpoint", () => {
    it("records a checkpoint through MCP and reports success, not the internal error a bigint id used to cause", async () => {
      const itemId = await seedItem();
      await callTool("claim", claimInput(itemId));
      const result = await callTool("checkpoint", {
        itemId,
        sessionId: "s1",
        body: "Tried X, ruled out Y, next is Z.",
      });
      // This is the load-bearing assertion: `checkpoint` returns
      // `AppendedEvent` with real bigint `id`/`txId`
      // (src/lib/events.ts). Before `bigintSafe` (src/lib/mcp/result.ts),
      // rendering this value threw inside `toolSuccess`, which `callTool`'s
      // try/catch turned into `isError: true, code: "internal"` — even
      // though the row below was already committed. If that fix regresses,
      // this assertion fails while the database row still exists, which is
      // exactly the mismatch this test is here to catch.
      expect(result.isError).toBeFalsy();
      expect(typeof (result.structuredContent as { id: string }).id).toBe("string");

      const rows = await prisma.event.findMany({ where: { itemId, type: "checkpoint" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe("Tried X, ruled out Y, next is Z.");
    });

    it("rejects a checkpoint through MCP from a session holding no live assignment", async () => {
      const itemId = await seedItem();
      const result = await callTool("checkpoint", { itemId, sessionId: "ghost", body: "x" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        code: "conflict",
        fields: ["itemId", "sessionId"],
      });
    });

    it("rejects an empty checkpoint body through MCP as invalid_input", async () => {
      const itemId = await seedItem();
      await callTool("claim", claimInput(itemId));
      const result = await callTool("checkpoint", { itemId, sessionId: "s1", body: "   " });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "invalid_input" });
    });
  });

  // ---------------------------------------------------------------------
  // note — the same regression coverage as checkpoint, for the same reason.
  // ---------------------------------------------------------------------

  describe("note", () => {
    it("records a note through MCP with no live assignment required, and reports success", async () => {
      const itemId = await seedItem();
      const result = await callTool("note", { itemId, body: "A remark from MCP." });
      expect(result.isError).toBeFalsy();
      expect(typeof (result.structuredContent as { id: string }).id).toBe("string");

      const rows = await prisma.event.findMany({ where: { itemId, type: "note" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe("A remark from MCP.");
      expect(rows[0]?.assignmentId).toBeNull();
    });

    it("attributes a note through MCP to the caller's live assignment when sessionId names one", async () => {
      const itemId = await seedItem();
      const claimed = await callTool("claim", claimInput(itemId));
      const assignmentId = (claimed.structuredContent as { id: string }).id;

      await callTool("note", { itemId, sessionId: "s1", body: "from the builder" });

      const rows = await prisma.event.findMany({ where: { itemId, type: "note" } });
      expect(rows[0]?.assignmentId).toBe(assignmentId);
      expect(rows[0]?.actorType).toBe("agent");
    });

    it("rejects an empty note body through MCP as invalid_input", async () => {
      const itemId = await seedItem();
      const result = await callTool("note", { itemId, body: "" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "invalid_input" });
    });

    it("rejects a note on a non-existent item through MCP as not_found", async () => {
      const result = await callTool("note", { itemId: "no-such-item", body: "x" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "not_found", fields: ["itemId"] });
    });
  });

  // ---------------------------------------------------------------------
  // The expired-lease path — the liveness sweep (MILESTONES.md #24) frees a
  // dead claim, and a fresh claim through MCP is what proves it actually
  // did.
  // ---------------------------------------------------------------------

  describe("an expired lease, freed by the liveness sweep, is claimable again through MCP", () => {
    it("refuses a second orchestrator while the lease is live, then accepts one once the sweep releases it", async () => {
      const itemId = await seedItem();

      const first = await callTool(
        "claim",
        claimInput(itemId, {
          role: "orchestrator",
          sessionId: "stale-session",
          rootSessionId: "stale-session",
        }),
      );
      expect(first.isError).toBeFalsy();

      // Before: the lease is live, so a second orchestrator is refused —
      // the same conflict the sequential test above establishes, repeated
      // here as the "before" half of this test's own before/after.
      const blocked = await callTool(
        "claim",
        claimInput(itemId, {
          role: "orchestrator",
          sessionId: "fresh-session",
          rootSessionId: "fresh-session",
        }),
      );
      expect(blocked.isError).toBe(true);

      // Force the stale assignment's lastActive far enough back that the
      // default `liveness.dead_after_seconds` (1800s) has elapsed, then run
      // the real sweep — the same function the periodic job calls, not a
      // stand-in for it.
      await prisma.assignment.updateMany({
        where: { itemId, sessionId: "stale-session" },
        data: { lastActive: new Date(Date.now() - 3_600_000) },
      });
      const dbHandle: TransactionHandle = {
        $queryRawUnsafe: (query: string, ...values: unknown[]) =>
          prisma.$queryRawUnsafe(query, ...values),
        $executeRawUnsafe: (query: string, ...values: unknown[]) =>
          prisma.$executeRawUnsafe(query, ...values),
      };
      const sweepResult = await sweepLiveness(dbHandle, defaultSnapshot(), {
        actorType: "system",
        actorId: null,
      });
      expect(sweepResult.released.length).toBeGreaterThan(0);

      // After: the item was refusing a second orchestrator a moment ago and
      // now accepts one through the exact same MCP call — the expired lease
      // genuinely freed the item, this isn't just the sweep's own report.
      const afterSweep = await callTool(
        "claim",
        claimInput(itemId, {
          role: "orchestrator",
          sessionId: "fresh-session",
          rootSessionId: "fresh-session",
        }),
      );
      expect(afterSweep.isError).toBeFalsy();
      expect(afterSweep.structuredContent).toMatchObject({
        sessionId: "fresh-session",
        role: "orchestrator",
      });
    });
  });
});
