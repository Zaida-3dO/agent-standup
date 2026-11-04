// The HTTP adapter's document routes, driven directly as route handlers against
// a real Postgres: `GET`/`PATCH /api/items/{id}/docs/{doc}` and
// `GET /api/items/{id}/docs/{doc}/children` (SCHEMA.md §8c).
//
// The routes are thin shells over one service call each, so what is worth
// proving is the part a shell can get wrong that an operation test cannot see:
// that the path parameters win over anything else in the request, that each
// query parameter reaches the operation typed (a repeated `keys`, a numeric
// `limit`), that a malformed body is a 400 rather than a 500, and that each
// refusal comes back with the status its code maps to. Skips without
// TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authenticatedRequest, stubAuthEnvironment } from "./helpers/authenticated-requests";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

interface DocEntryBody {
  key: string;
  value: unknown;
  rev: number;
}
interface GetBody {
  itemId: string;
  doc: string;
  rev: number;
  entries: DocEntryBody[];
  nextCursor: string | null;
  missing: string[];
}
interface ErrorBody {
  error: { code: string; message: string; fields?: string[]; details?: Record<string, unknown> };
}

describeIfDb("document HTTP routes against Postgres", () => {
  beforeAll(stubAuthEnvironment);

  const dbName = scratchDatabaseName("doc_routes");
  let prisma: PrismaClient;
  let itemsRoute: typeof import("@/app/api/items/route");
  let docRoute: typeof import("@/app/api/items/[id]/docs/[doc]/route");
  let childrenRoute: typeof import("@/app/api/items/[id]/docs/[doc]/children/route");

  beforeAll(async () => {
    const scratch = await createMigratedScratchDatabase(testDatabaseUrl!, dbName);
    // `service/live.ts` builds its singleton on module load from DATABASE_URL,
    // so it must point at the scratch database before the routes are imported.
    process.env.DATABASE_URL = scratch.url;
    itemsRoute = await import("@/app/api/items/route");
    docRoute = await import("@/app/api/items/[id]/docs/[doc]/route");
    childrenRoute = await import("@/app/api/items/[id]/docs/[doc]/children/route");
    prisma = createTestPrismaClient(scratch.url);
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  const BASE = "http://localhost/api/items";

  async function createItem(title: string, parentId?: string): Promise<string> {
    const response = await itemsRoute.POST(
      authenticatedRequest(BASE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          body: "x",
          area: "doc-routes",
          originType: "auto",
          ...(parentId === undefined ? {} : { parentId }),
        }),
      }),
    );
    expect(response.status).toBe(201);
    return ((await response.json()) as { item: { id: string } }).item.id;
  }

  const params = (id: string, doc: string) => ({ params: Promise.resolve({ id, doc }) });

  function patchRequest(id: string, doc: string, body: unknown): Request {
    return authenticatedRequest(`${BASE}/${id}/docs/${doc}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function patch(id: string, doc: string, body: unknown): Promise<Response> {
    return docRoute.PATCH(patchRequest(id, doc, body), params(id, doc));
  }

  async function get(id: string, doc: string, query = ""): Promise<Response> {
    return docRoute.GET(authenticatedRequest(`${BASE}/${id}/docs/${doc}${query}`), params(id, doc));
  }

  describe("PATCH /items/{id}/docs/{doc}", () => {
    it("writes the keys and answers with the new revision", async () => {
      const id = await createItem("Patch target");
      const response = await patch(id, "progress", { set: { a: 1, b: { n: 2 } } });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { rev: number; changed: boolean; itemId: string };
      expect(body).toMatchObject({ rev: 1, changed: true, itemId: id });

      const read = (await (await get(id, "progress")).json()) as GetBody;
      expect(read.entries.map((entry) => [entry.key, entry.value])).toEqual([
        ["a", 1],
        ["b", { n: 2 }],
      ]);
    });

    it("lets the path win over an itemId or doc in the body", async () => {
      // Killed by spreading the path parameters before the body: a body that
      // names another item or document would then write there instead.
      const id = await createItem("Path wins");
      const other = await createItem("Not this one");
      const response = await patch(id, "progress", {
        itemId: other,
        doc: "elsewhere",
        set: { a: 1 },
      });
      expect(response.status).toBe(200);
      expect(((await (await get(id, "progress")).json()) as GetBody).entries).toHaveLength(1);
      expect(((await (await get(other, "elsewhere")).json()) as GetBody).entries).toHaveLength(0);
      expect(((await (await get(other, "progress")).json()) as GetBody).entries).toHaveLength(0);
    });

    it("answers malformed JSON with a 400, not a 500", async () => {
      const id = await createItem("Bad body");
      const response = await patch(id, "progress", "{not json");
      expect(response.status).toBe(400);
      const body = (await response.json()) as ErrorBody;
      expect(body.error.code).toBe("invalid_input");
      expect(body.error.message).toContain("valid JSON");
    });

    it("answers an ifRev clash with a 409 conflict naming the clashing key", async () => {
      const id = await createItem("Clash target");
      await patch(id, "progress", { set: { a: 1 } });
      await patch(id, "progress", { set: { a: 2 }, ifRev: 1 });
      const response = await patch(id, "progress", { set: { a: 3 }, ifRev: 1 });
      expect(response.status).toBe(409);
      const body = (await response.json()) as ErrorBody;
      expect(body.error.code).toBe("conflict");
      expect(body.error.fields).toEqual(["ifRev"]);
      expect(body.error.details).toMatchObject({ currentRev: 2, ifRev: 1, keys: ["a"] });
    });

    it("answers an unknown item with a 404", async () => {
      const response = await patch("no-such-item", "progress", { set: { a: 1 } });
      expect(response.status).toBe(404);
      expect(((await response.json()) as ErrorBody).error.code).toBe("not_found");
    });

    it("answers a patch that names no key with a 400 naming the fields", async () => {
      const id = await createItem("Empty patch");
      const response = await patch(id, "progress", {});
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).error.fields).toEqual(["set", "delete"]);
    });

    it("answers a request with no credentials with a 401 and writes nothing", async () => {
      const id = await createItem("Unauthenticated");
      const response = await docRoute.PATCH(
        new Request(`${BASE}/${id}/docs/progress`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ set: { a: 1 } }),
        }),
        params(id, "progress"),
      );
      expect(response.status).toBe(401);
      expect(((await (await get(id, "progress")).json()) as GetBody).rev).toBe(0);
    });
  });

  describe("GET /items/{id}/docs/{doc}", () => {
    async function seeded(): Promise<string> {
      const id = await createItem("Read target");
      await patch(id, "progress", {
        set: { "s-a": 1, "s-b": 2, "s-c": 3, other: 4 },
      });
      return id;
    }

    it("lets the path win over an itemId or doc in the query string", async () => {
      // Killed by reading `itemId` or `doc` off the query string.
      const id = await seeded();
      const other = await createItem("Query decoy");
      const response = await get(id, "progress", `?itemId=${other}&doc=elsewhere`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as GetBody;
      expect(body.itemId).toBe(id);
      expect(body.doc).toBe("progress");
      expect(body.entries).toHaveLength(4);
    });

    it("reads a repeated keys parameter as a list, and reports the missing ones", async () => {
      // Killed by reading `keys` with `searchParams.get`, which keeps only one.
      const id = await seeded();
      const response = await get(id, "progress", "?keys=s-a&keys=other&keys=ghost");
      const body = (await response.json()) as GetBody;
      expect(body.entries.map((entry) => entry.key)).toEqual(["other", "s-a"]);
      expect(body.missing).toEqual(["ghost"]);
    });

    it("passes prefix through to the operation", async () => {
      const id = await seeded();
      const body = (await (await get(id, "progress", "?prefix=s-")).json()) as GetBody;
      expect(body.entries.map((entry) => entry.key)).toEqual(["s-a", "s-b", "s-c"]);
    });

    it("types limit as a number and follows cursor to the next page", async () => {
      // A string `limit` would be refused by the operation's schema, so a 200
      // with one entry is the proof it arrived as a number.
      const id = await seeded();
      const first = (await (await get(id, "progress", "?prefix=s-&limit=2")).json()) as GetBody;
      expect(first.entries.map((entry) => entry.key)).toEqual(["s-a", "s-b"]);
      expect(first.nextCursor).not.toBeNull();

      const second = (await (
        await get(
          id,
          "progress",
          `?prefix=s-&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).json()) as GetBody;
      expect(second.entries.map((entry) => entry.key)).toEqual(["s-c"]);
      expect(second.nextCursor).toBeNull();
    });

    it("refuses a limit that is not a number with a 400 naming it", async () => {
      const id = await seeded();
      const response = await get(id, "progress", "?limit=lots");
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorBody).error.fields).toContain("limit");
    });

    it("answers an unknown item with a 404", async () => {
      const response = await get("no-such-item", "progress");
      expect(response.status).toBe(404);
      expect(((await response.json()) as ErrorBody).error.code).toBe("not_found");
    });

    it("answers a request with no credentials with a 401", async () => {
      const id = await seeded();
      const response = await docRoute.GET(
        new Request(`${BASE}/${id}/docs/progress`),
        params(id, "progress"),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("GET /items/{id}/docs/{doc}/children", () => {
    async function family(): Promise<{ parent: string; childA: string; childB: string }> {
      const parent = await createItem("Parent project");
      const childA = await createItem("Child A", parent);
      const childB = await createItem("Child B", parent);
      await patch(childA, "progress", { set: { x: "from-a", y: "also-a" } });
      await patch(childB, "progress", { set: { x: "from-b" } });
      return { parent, childA, childB };
    }

    const childrenGet = (id: string, doc: string, query = "") =>
      childrenRoute.GET(
        authenticatedRequest(`${BASE}/${id}/docs/${doc}/children${query}`),
        params(id, doc),
      );

    it("reads the document across the children, each entry tagged with its child", async () => {
      const { parent, childA, childB } = await family();
      const response = await childrenGet(parent, "progress");
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        parentId: string;
        entries: { itemId: string; key: string; value: unknown }[];
      };
      expect(body.parentId).toBe(parent);
      const pairs = body.entries.map((entry) => `${entry.itemId}:${entry.key}`);
      expect(pairs.sort()).toEqual([`${childA}:x`, `${childA}:y`, `${childB}:x`].sort());
    });

    it("lets the path win over a parentId or doc in the query string", async () => {
      const { parent } = await family();
      const decoy = await createItem("Decoy parent");
      const response = await childrenGet(parent, "progress", `?parentId=${decoy}&doc=elsewhere`);
      const body = (await response.json()) as { parentId: string; doc: string; entries: unknown[] };
      expect(body.parentId).toBe(parent);
      expect(body.doc).toBe("progress");
      expect(body.entries).toHaveLength(3);
    });

    it("types limit as a number and pages with cursor", async () => {
      const { parent } = await family();
      const first = (await (await childrenGet(parent, "progress", "?limit=2")).json()) as {
        entries: unknown[];
        nextCursor: string | null;
      };
      expect(first.entries).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = (await (
        await childrenGet(
          parent,
          "progress",
          `?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).json()) as { entries: unknown[]; nextCursor: string | null };
      expect(second.entries).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
    });

    it("answers an unknown parent with a 404, and no credentials with a 401", async () => {
      const missing = await childrenGet("no-such-item", "progress");
      expect(missing.status).toBe(404);
      const { parent } = await family();
      const unauthenticated = await childrenRoute.GET(
        new Request(`${BASE}/${parent}/docs/progress/children`),
        params(parent, "progress"),
      );
      expect(unauthenticated.status).toBe(401);
    });
  });
});
