// MCP read tools — `get_item`, `list_items`, `my_work`, `orientation`
// (MILESTONES.md #31, SCHEMA.md §18).
//
// `tests/mcp-server.test.ts` proves the *mechanism* — every registered
// operation becomes a tool, with the operation's own schema, description and
// read/write annotation, and every rejection survives the SDK unedited. That
// coverage is generic: it is driven by `service_info` and by operations
// planted for the occasion, so it says nothing about whether these four
// specific tools behave correctly with real data.
//
// This file is the other half: each of the four read tools, called by its
// real MCP name through a real `Client`/`InMemoryTransport` pair (the same
// harness `mcp-server.test.ts` uses), against a real Postgres-backed
// `ServiceRuntime` — not an inert transaction handle. `get_item` and
// `list_items` already have thorough operation-level DB coverage
// (tests/items-operations.test.ts), `my_work` and `orientation` have their
// own (tests/my-work-operation.test.ts, tests/orientation-operation.test.ts).
// What none of those prove is that calling the tool *by its MCP name*, with
// arguments shaped as a client would send them, reaches the same operation
// and returns the same data — which is the actual claim row #31 makes ("MCP
// read tools: get item, list items, my work, orientation").
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem, type ClaimInput } from "@/lib/claims";
import { createMcpServer, type ServiceCall } from "@/lib/mcp";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("MCP read tools against Postgres", () => {
  const dbName = scratchDatabaseName("mcp_read_tools");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let client: Client;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    const call: ServiceCall = (name, input, options) => runtime.call(name, input, options);
    const server = createMcpServer({ adapter: "mcp_http", call, transport: "mcp-test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "read-tools-test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function makeItem(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    return (await runtime.call("create_item", {
      title: "MCP read-tools subject",
      body: "x",
      area: "mcp-read-tools",
      originType: "auto",
      ...overrides,
    })) as { id: string };
  }

  async function claim(input: ClaimInput) {
    return prisma.$transaction((tx) => claimItem(tx, input));
  }

  /** Calls a tool over the real MCP wire and returns its `structuredContent`. */
  async function call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await client.callTool({ name, arguments: args });
    const structuredContent = result.structuredContent as Record<string, unknown> | undefined;
    if (result.isError) {
      throw new Error(`tool ${name} returned isError with ${JSON.stringify(structuredContent)}`);
    }
    return structuredContent!;
  }

  describe("get_item", () => {
    it("returns the item created via the service layer, reached by its MCP tool name", async () => {
      const created = await makeItem({ title: "Readable over MCP", priority: "P1" });

      // `full: true` over the wire — MILESTONES.md #107 requires the opt-in
      // to reach every surface, and MCP is the one it exists for. If the
      // parameter were absent from the advertised schema or dropped between
      // the tool and the operation, `priority` would come back undefined.
      const result = await call("get_item", { id: created.id, full: true });

      // Single-character mutation this catches: a handler that called
      // `list_items` instead of `get_item` (or dropped `id` from the
      // arguments) would return a different shape or throw not_found here.
      expect(result.id).toBe(created.id);
      expect(result.title).toBe("Readable over MCP");
      expect(result.priority).toBe("P1");
    });

    it("surfaces the service's not_found through the tool result, with isError set", async () => {
      const result = await client.callTool({
        name: "get_item",
        arguments: { id: "no-such-item-over-mcp" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "not_found", fields: ["id"] });
    });
  });

  describe("list_items", () => {
    it("filters by area over the wire — a genuine exclusion, not just an unfiltered echo", async () => {
      const kept = await makeItem({ area: "mcp-list-area-a" });
      await makeItem({ area: "mcp-list-area-b" });

      // `full: true` for the same reason — `area` is not in the slim shape.
      const result = await call("list_items", { area: "mcp-list-area-a", full: true });
      const items = result.items as { id: string; area: string }[];

      expect(items.map((i) => i.id)).toEqual([kept.id]);
      expect(items.every((i) => i.area === "mcp-list-area-a")).toBe(true);
    });

    it("returns an empty page over MCP rather than an error when nothing matches", async () => {
      const result = await call("list_items", { area: "an-mcp-area-nothing-uses" });
      expect(result.items).toEqual([]);
      expect(result.nextCursor).toBeNull();
    });

    it("rejects an unknown filter field with invalid_input, fields naming it", async () => {
      // The operation's `.strict()` schema — proves a client sending an
      // unrecognised argument is refused by the service (through
      // `advertisedSchema`'s permissive wrapper), not silently ignored.
      const result = await client.callTool({
        name: "list_items",
        arguments: { areaTypo: "mcp-list-area-a" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "invalid_input" });
    });
  });

  describe("my_work", () => {
    it("returns only the item THIS session holds, with its own role, called by MCP name", async () => {
      const held = await makeItem({ title: "Held via MCP" });
      await makeItem({ title: "Not held via MCP" });
      await claim({
        itemId: held.id,
        role: "builder",
        holderType: "agent",
        holderId: "crew-mcp-reader",
        sessionId: "session-mcp-my-work",
        machine: "laptop",
      });

      const result = await call("my_work", { sessionId: "session-mcp-my-work" });
      const items = result.items as { item: { id: string }; assignment: { role: string } }[];

      expect(items).toHaveLength(1);
      expect(items[0]?.item.id).toBe(held.id);
      expect(items[0]?.assignment.role).toBe("builder");
    });

    it("a session holding nothing gets an empty list over MCP, not an error", async () => {
      const result = await call("my_work", { sessionId: "session-mcp-empty" });
      expect(result.items).toEqual([]);
    });
  });

  describe("orientation", () => {
    it("returns item, checkpoint and crew for a fresh session catching up, over MCP", async () => {
      const item = await makeItem({ title: "Orientation over MCP" });
      await claim({
        itemId: item.id,
        role: "orchestrator",
        holderType: "agent",
        holderId: "crew-mcp-orchestrator",
        sessionId: "session-mcp-orientation",
        machine: "laptop",
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Event" ("itemId", "actorType", "actorId", "type", "payload", "body")
         VALUES ($1, 'agent'::"ActorType", 'crew-mcp-orchestrator', 'checkpoint'::"EventType", '{}'::jsonb, $2)`,
        item.id,
        "Checkpoint left over MCP",
      );

      const result = await call("orientation", { itemId: item.id });

      const orientationItem = result.item as { id: string };
      const checkpoint = result.checkpoint as { body: string } | null;
      const crew = result.crew as { holderId: string; role: string }[];

      expect(orientationItem.id).toBe(item.id);
      expect(checkpoint?.body).toBe("Checkpoint left over MCP");
      expect(crew).toHaveLength(1);
      expect(crew[0]?.holderId).toBe("crew-mcp-orchestrator");
      expect(crew[0]?.role).toBe("orchestrator");
    });

    it("surfaces not_found for an item id that does not exist, through the tool result", async () => {
      const result = await client.callTool({
        name: "orientation",
        arguments: { itemId: "no-such-item-orientation-mcp" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "not_found", fields: ["itemId"] });
    });

    it("rejects a since value that is not a decimal integer string, same as the operation would directly", async () => {
      const item = await makeItem({ title: "Bad since over MCP" });
      const result = await client.callTool({
        name: "orientation",
        arguments: { itemId: item.id, since: "not-a-number" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ code: "invalid_input" });
    });
  });

  describe("all four are read-only per the registry's own kind, as advertised over MCP", () => {
    it("annotates get_item, list_items, my_work and orientation readOnlyHint: true", async () => {
      const { tools } = await client.listTools();
      for (const name of ["get_item", "list_items", "my_work", "orientation"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool, `expected a tool named ${name}`).toBeDefined();
        expect(tool?.annotations?.readOnlyHint).toBe(true);
      }
    });
  });
});
