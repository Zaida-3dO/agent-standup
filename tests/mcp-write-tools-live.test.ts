// MCP write tools — MILESTONES.md #32 — against a real Postgres, driven
// through a real MCP client the way `tests/mcp-server.test.ts` drives the
// generic core. `tests/mcp-write-tools.test.ts` proves the adapter's own
// logic (registration, schema, the rehearsal wrapper) with stubs; this file
// proves the same four tools actually create, edit, move and complete a row
// end to end — and, the point of this row's one new mechanism, that a
// `transition_item` dry-run reaches the agent as a preview and genuinely
// writes nothing, the same guarantee `transition-complete-operations.test.ts`
// already proves for the operation directly, now proved through MCP.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import {
  ServiceRuntime,
  getOperation,
  guardRegistry,
  prismaTransactionRunner,
  ALL_GUARDS,
  type AnyOperation,
} from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { createMcpServer, withRehearsalUnwrapping } from "@/lib/mcp";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const WRITE_TOOL_NAMES = ["create_item", "update_item", "transition_item", "complete_item"];

function validSummary(overrides: Record<string, unknown> = {}) {
  return {
    shipped: ["Delivered the thing."],
    not_done: [],
    user_facing: false,
    how_verified: "Ran it locally and watched it work end to end.",
    watch_for: [],
    ...overrides,
  };
}

describeIfDb("MCP write tools against Postgres", () => {
  const dbName = scratchDatabaseName("mcp_write_tools");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let client: Client;

  beforeAll(async () => {
    scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: scratchUrl } });
    if (!result.ok) {
      throw new Error(`migrate deploy failed against scratch db ${dbName}`);
    }
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });

    // Same production guard set `transition-complete-operations.test.ts`
    // registers — this suite is proving the real wiring, not a scratch
    // registry standing in for it.
    for (const guard of ALL_GUARDS) {
      if (!guardRegistry.has(guard.id)) guardRegistry.register(guard);
    }

    const runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    const operations = WRITE_TOOL_NAMES.map((name) => {
      const operation = getOperation(name);
      if (!operation) throw new Error(`missing operation: ${name}`);
      return operation;
    }) as AnyOperation[];

    const server = createMcpServer({
      call: withRehearsalUnwrapping((name, input, options) => runtime.call(name, input, options)),
      transport: "mcp-test",
      operations,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "Summary"`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Event"`);
    await prisma.item.deleteMany({});
  });

  async function itemState(id: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<{ state: string }[]>(
      `SELECT "state" FROM "Item" WHERE "id" = $1`,
      id,
    );
    return rows[0]!.state;
  }

  async function eventCount(id: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count" FROM "Event" WHERE "itemId" = $1`,
      id,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  /** A root project, then a task under it — a project has no state to transition. */
  async function createTaskViaMcp(): Promise<string> {
    const projectResult = await client.callTool({
      name: "create_item",
      arguments: {
        title: "MCP write-tools project",
        body: "x",
        area: "mcp-write-tools",
        originType: "auto",
      },
    });
    expect(projectResult.isError).toBeFalsy();
    const project = (projectResult.structuredContent as { id: string }).id;

    const taskResult = await client.callTool({
      name: "create_item",
      arguments: {
        title: "MCP write-tools task",
        body: "x",
        area: "mcp-write-tools",
        originType: "auto",
        parentId: project,
      },
    });
    expect(taskResult.isError).toBeFalsy();
    return (taskResult.structuredContent as { id: string }).id;
  }

  it("create_item creates a real row, reachable by a later call", async () => {
    const id = await createTaskViaMcp();
    expect(await itemState(id)).toBe("on_deck");
  });

  it("update_item edits a non-state field for real", async () => {
    const id = await createTaskViaMcp();
    const result = await client.callTool({
      name: "update_item",
      arguments: { id, title: "Retitled via MCP" },
    });
    expect(result.isError).toBeFalsy();
    const rows = await prisma.$queryRawUnsafe<{ title: string }[]>(
      `SELECT "title" FROM "Item" WHERE "id" = $1`,
      id,
    );
    expect(rows[0]?.title).toBe("Retitled via MCP");
  });

  describe("transition_item's dry_run, through MCP", () => {
    it("an allowed preview reports allowed:true and writes nothing", async () => {
      const id = await createTaskViaMcp();
      const before = await itemState(id);
      const beforeEvents = await eventCount(id);

      const result = await client.callTool({
        name: "transition_item",
        arguments: { id, to: "executing", dryRun: true },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        outcome: { allowed: boolean; rehearsed: boolean; from: string; to: string };
      };
      expect(structured.outcome).toMatchObject({ allowed: true, rehearsed: true, to: "executing" });

      // The guarantee this row's wrapper must not weaken: the state and
      // event count are exactly what they were before the call.
      expect(await itemState(id)).toBe(before);
      expect(await eventCount(id)).toBe(beforeEvents);
    });

    it("a refused preview reports allowed:false, with the guard identifier, and still writes nothing", async () => {
      const id = await createTaskViaMcp();
      const beforeEvents = await eventCount(id);

      const result = await client.callTool({
        name: "transition_item",
        arguments: { id, to: "blocked", dryRun: true },
      });

      // The load-bearing assertion: a *rejected* rehearsal is still not an
      // MCP error. Before this row, every dry-run — allowed or refused —
      // reached the client as `isError: true, code: "internal"`.
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        outcome: { allowed: boolean; rejection?: { guard: string } };
      };
      expect(structured.outcome.allowed).toBe(false);
      expect(structured.outcome.rejection?.guard).toBeTruthy();

      expect(await itemState(id)).toBe("on_deck");
      expect(await eventCount(id)).toBe(beforeEvents);
    });

    it("dryRun: false (or omitted) actually writes — the route reads the argument, not a hardcoded preview", async () => {
      const id = await createTaskViaMcp();

      const result = await client.callTool({
        name: "transition_item",
        arguments: { id, to: "executing" },
      });

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { outcome: { rehearsed: boolean } };
      expect(structured.outcome.rehearsed).toBe(false);
      expect(await itemState(id)).toBe("executing");
      expect(await eventCount(id)).toBe(1);
    });
  });

  it("complete_item finishes an item and persists its summary", async () => {
    const id = await createTaskViaMcp();

    const result = await client.callTool({
      name: "complete_item",
      arguments: { id, to: "wont_do", summary: validSummary() },
    });

    expect(result.isError).toBeFalsy();
    expect(await itemState(id)).toBe("wont_do");
    const summaryRows = await prisma.$queryRawUnsafe<{ shipped: unknown }[]>(
      `SELECT "shipped" FROM "Summary" WHERE "itemId" = $1`,
      id,
    );
    expect(summaryRows).toHaveLength(1);
  });

  it("complete_item's own rejection (an invalid summary) reaches the client as an MCP error, unaffected by the rehearsal wrapper", async () => {
    const id = await createTaskViaMcp();

    const result = await client.callTool({
      name: "complete_item",
      arguments: { id, to: "wont_do", summary: validSummary({ shipped: [] }) },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "guard_rejected" });
    expect(await itemState(id)).toBe("on_deck");
  });
});
