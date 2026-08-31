// MILESTONES.md #113 — "A round trip that is not ASCII."
//
// Two field reports independently concluded the server was corrupting
// non-ASCII titles (an em dash landing as U+FFFD). Both used `curl`, and
// neither could rule out their own request encoding. Verified directly: the
// server has no manual byte-handling anywhere on this path — `POST /api/mcp`
// and `POST /api/items` both terminate in Web-standard `Request.json()`
// (`src/app/api/mcp/route.ts`, `src/app/api/items/route.ts`), which decodes
// UTF-8 per the Fetch/WHATWG spec, and `create_item`'s insert
// (`src/lib/service/operations/create-item.ts`) is a parameterised
// `$queryRawUnsafe` — the driver sends the JS string as UTF-8 bytes, nobody
// in this codebase touches an encoding. The suspect was `curl` on a Windows
// console, which encodes an unescaped em dash as CP1252 `0x97` rather than
// UTF-8 — bytes this server never claimed to interpret as anything other
// than UTF-8.
//
// This file proves three things:
//
// 1. **Valid UTF-8 survives intact**, POSTed as real bytes (`Request`'s
//    `body` is serialised and re-decoded exactly the way a network client's
//    would be — see `mcp-http.test.ts`'s header for why that is "the real
//    HTTP boundary" without a listening server), through two surfaces: the
//    MCP `create_work`/`get_item` tools (`create_work` is the one creation
//    tool the MCP surface advertises, and `type: "project"` is its one mode
//    that needs no parent, so the bytes cross the identical seam with no
//    unrelated setup) and
//    the plain `POST /api/items` + `GET /api/items/{id}` route (the
//    surface `items-routes.test.ts` already covers for ASCII).
//
//    The em dash is deliberately **not** one of these "must survive
//    unchanged" samples — see (3).
//
// 2. **Invalid bytes are not silently the server's fault either.** A lone,
//    undecodable UTF-8 byte reaches `Request.json()` and is replaced with
//    U+FFFD *by the platform*, not refused — proven directly against
//    `Request`/`TextDecoder`, with no service code in the call path at all,
//    so a claim that the service caused it is falsifiable by this test
//    alone. Documented, not fixed: substituting on invalid input is
//    `TextDecoder`'s non-fatal default, not a decision this codebase makes.
//
// 3. **`title`'s em-dash normalisation (`@/lib/text-normalize.ts`) and the
//    round trip above sit in genuine, deliberate tension for that one field
//    and that one character.** A correctly-decoded em dash in a `title` is
//    rewritten to a hyphen on purpose (MILESTONES.md #113's third part,
//    "a task tracker should store `-`"), so `title` is the one field this
//    file does NOT assert is byte-identical for an em dash — it asserts the
//    opposite, deliberately. `body` carries no such rule and an em dash in
//    `body` round-trips untouched, which is asserted directly to prove the
//    normalisation is scoped to `title` and did not leak.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authenticatedRequest,
  stubAuthEnvironment,
  withAuth,
} from "./helpers/authenticated-requests";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { handleMcpRequest } from "@/lib/mcp/http";
import type { ServiceCall } from "@/lib/mcp";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const PROTOCOL_VERSION = "2025-06-18";

/**
 * A representative, non-exhaustive spread of non-ASCII that MUST survive a
 * round trip byte-identical. Deliberately excludes the em dash — `title`
 * rewrites it on purpose (see the file header, point 3), so it is asserted
 * separately rather than folded into "must be unchanged".
 */
const NON_ASCII_SAMPLES: Record<string, string> = {
  "curly quotes": "the “fast” path",
  "accented Latin": "café naïve résumé",
  "non-Latin script": "日本語テスト",
  emoji: "shipped 🎉🚀",
};

describeIfDb("UTF-8 survives the real HTTP boundary (MILESTONES.md #113)", () => {
  const dbName = scratchDatabaseName("utf8_round_trip");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let call: ServiceCall;
  // Route handlers only, imported after DATABASE_URL points at the scratch
  // DB — same ordering constraint `items-routes.test.ts` documents.
  let collectionRoute: typeof import("@/app/api/items/route");
  let itemRoute: typeof import("@/app/api/items/[id]/route");

  beforeAll(async () => {
    // One route in this file is reached through its own handler, which
    // authenticates; the MCP cases below call `handleMcpRequest` directly,
    // beneath the mount that would.
    stubAuthEnvironment();
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    call = (name, input, options) => runtime.call(name, input, options);
    collectionRoute = await import("@/app/api/items/route");
    itemRoute = await import("@/app/api/items/[id]/route");
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  function mcpPost(body: unknown): Request {
    return new Request("http://mcp.test/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
      },
      body: JSON.stringify(body),
    });
  }

  async function mcpRpc(message: unknown): Promise<Record<string, unknown>> {
    const response = await handleMcpRequest(mcpPost(message), call);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  async function initMcp(): Promise<void> {
    await mcpRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "utf8-test-client", version: "0.0.0" },
      },
    });
  }

  describe.each(Object.entries(NON_ASCII_SAMPLES))("%s — %s", (label, sample) => {
    it(`MCP create_work then get_item returns "${label}" byte-identical`, async () => {
      await initMcp();
      const createBody = await mcpRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "create_work",
          arguments: {
            type: "project",
            title: sample,
            body: `body containing ${sample}`,
            area: "utf8-round-trip",
            originType: "auto",
          },
        },
      });
      const createResult = createBody.result as {
        isError?: boolean;
        structuredContent: { id: string; title: string };
      };
      expect(createResult.isError).toBeFalsy();
      // The create response itself must already carry the exact string —
      // catches corruption on the write path before a second call is even
      // needed to prove it survived storage too.
      expect(createResult.structuredContent.title).toBe(sample);

      const id = createResult.structuredContent.id;
      const getBody = await mcpRpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_item", arguments: { id, full: true } },
      });
      const getResult = getBody.result as {
        isError?: boolean;
        structuredContent: { title: string; body: string };
      };
      expect(getResult.isError).toBeFalsy();
      // Read back through a *second*, independent request — proves storage
      // round-trips it, not just that the create response echoed the input.
      expect(getResult.structuredContent.title).toBe(sample);
      expect(getResult.structuredContent.body).toBe(`body containing ${sample}`);
    });

    it(`POST /api/items then GET returns "${label}" byte-identical`, async () => {
      const postResponse = await collectionRoute.POST(
        new Request("http://localhost/api/items", {
          method: "POST",
          headers: withAuth({ "content-type": "application/json" }),
          body: JSON.stringify({
            title: sample,
            body: `body containing ${sample}`,
            area: "utf8-round-trip-rest",
            originType: "auto",
          }),
        }),
      );
      expect(postResponse.status).toBe(201);
      const postPayload = (await postResponse.json()) as { item: { id: string; title: string } };
      expect(postPayload.item.title).toBe(sample);

      const getResponse = await itemRoute.GET(
        authenticatedRequest(`http://localhost/api/items/${postPayload.item.id}?full=true`),
        { params: Promise.resolve({ id: postPayload.item.id }) },
      );
      expect(getResponse.status).toBe(200);
      const getPayload = (await getResponse.json()) as {
        item: { title: string; body: string };
      };
      expect(getPayload.item.title).toBe(sample);
      expect(getPayload.item.body).toBe(`body containing ${sample}`);
    });
  });

  it("a title spanning multiple non-ASCII scripts in one string round-trips whole, not just individually", async () => {
    const combined = Object.values(NON_ASCII_SAMPLES).join(" / ");
    await initMcp();
    const createBody = await mcpRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "create_work",
        arguments: {
          type: "project",
          title: combined,
          body: "x",
          area: "utf8-round-trip",
          originType: "auto",
        },
      },
    });
    const createResult = createBody.result as {
      isError?: boolean;
      structuredContent: { id: string; title: string };
    };
    expect(createResult.isError).toBeFalsy();
    expect(createResult.structuredContent.title).toBe(combined);
  });

  it("an em dash in title is decoded correctly THEN deliberately normalised to a hyphen — not corrupted to U+FFFD", async () => {
    await initMcp();
    const createBody = await mcpRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "create_work",
        arguments: {
          type: "project",
          title: "Ship it — quickly",
          body: "the brief mentions an em dash — right here — twice",
          area: "utf8-round-trip",
          originType: "auto",
          // This case asserts on `body` over the real MCP boundary, and the
          // slim create response withholds it (#107) — so it asks for the
          // whole record rather than dropping the half of the assertion
          // that proves `body` keeps its em dashes.
          full: true,
        },
      },
    });
    const createResult = createBody.result as {
      isError?: boolean;
      structuredContent: { id: string; title: string; body: string };
    };
    expect(createResult.isError).toBeFalsy();
    // Never U+FFFD — the encoding fault this row disproves.
    expect(createResult.structuredContent.title).not.toContain("�");
    // The em dash arrived intact and was then normalised on purpose.
    expect(createResult.structuredContent.title).toBe("Ship it - quickly");
    // `body` carries no such rule: its em dashes are untouched.
    expect(createResult.structuredContent.body).toBe(
      "the brief mentions an em dash — right here — twice",
    );

    // And it survives a second, independent read the same way.
    const getBody = await mcpRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_item",
        arguments: { id: createResult.structuredContent.id, full: true },
      },
    });
    const getResult = getBody.result as {
      isError?: boolean;
      structuredContent: { title: string; body: string };
    };
    expect(getResult.isError).toBeFalsy();
    expect(getResult.structuredContent.title).toBe("Ship it - quickly");
    expect(getResult.structuredContent.body).toBe(
      "the brief mentions an em dash — right here — twice",
    );
  });
});

describe("undecodable bytes at the HTTP boundary (MILESTONES.md #113, companion)", () => {
  // The last case in this block reaches a real route handler, which
  // authenticates before it reads a body — so the token it presents has to
  // be configured here too. This block runs with no database, hence its own
  // stub rather than the one in the DB-gated block above.
  beforeEach(() => {
    stubAuthEnvironment();
  });

  // No database, no service call, and no route import: this reproduces the
  // failure mode with nothing but the platform's own `Request`/`TextDecoder`,
  // so it stands as proof the substitution happens before any of this
  // repository's code runs — not a claim resting on reading the source.
  it("a lone invalid UTF-8 byte inside an otherwise well-formed JSON string decodes to U+FFFD rather than throwing", async () => {
    const prefix = Buffer.from('{"title":"bad-', "utf8");
    const invalidByte = Buffer.from([0x80]); // a standalone UTF-8 continuation byte — invalid on its own
    const suffix = Buffer.from('-byte"}', "utf8");
    const body = Buffer.concat([prefix, invalidByte, suffix]);

    const request = new Request("http://mcp.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    const parsed = (await request.json()) as { title: string };
    expect(parsed.title).toBe("bad-�-byte");
    expect(parsed.title).not.toBe("bad--byte");
  });

  it("valid UTF-8 with no invalid bytes never introduces U+FFFD, as a negative control for the assertion above", async () => {
    // Guards the previous test against a matcher that would pass on *any*
    // string containing U+FFFD-shaped output, regardless of whether the
    // input actually had an invalid byte in it.
    const body = Buffer.from('{"title":"perfectly valid — em dash"}', "utf8");
    const request = new Request("http://mcp.test/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const parsed = (await request.json()) as { title: string };
    expect(parsed.title).not.toContain("�");
    expect(parsed.title).toBe("perfectly valid — em dash");
  });

  it("an invalid byte breaking JSON *structure* (not just a string's contents) is a 400 from the route, not a 500", async () => {
    process.env.DATABASE_URL ??= "postgres://placeholder/placeholder";
    const { POST } = await import("@/app/api/items/route");
    // The invalid byte sits where a structural character is expected, so the
    // decoded text is not valid JSON at all (a U+FFFD sits where `"` should
    // be), and `request.json()` throws a SyntaxError — the route's existing
    // catch-and-400 path, exercised here with a byte-level cause rather than
    // a typed one.
    const body = Buffer.concat([
      Buffer.from('{"title', "utf8"),
      Buffer.from([0x80]),
      Buffer.from('"x"}', "utf8"),
    ]);
    const response = await POST(
      new Request("http://localhost/api/items", {
        method: "POST",
        // The route authenticates before it reads the body, so an
        // unauthenticated call would be refused with a 401 and never reach
        // the decoding path this case exists to exercise.
        headers: withAuth({ "content-type": "application/json" }),
        body,
      }),
    );
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("invalid_input");
  });
});
