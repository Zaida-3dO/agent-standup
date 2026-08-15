// The registration route as a route — `POST /api/sessions/{id}/register`
// (SCHEMA.md §19, §21; MILESTONES.md #43), driven as a route handler against
// a real Postgres.
//
// ── Why this file exists separately from the adapter test ──────────────
//
// `session-register-adapters.test.ts` covers the *command line's* shell and
// the header helper as pure values. It does not reach this module, and a
// header claiming otherwise would be worse than no claim: the two properties
// below were both provably untested until this file, and one of them is a
// session-hijack.
//
// ── The property that needed a test, and what it costs to lose ─────────
//
// The route composes the operation's input as `{ ...body, sessionId: id }` —
// **the path segment last**. Reverse that spread and a request body's own
// `sessionId` wins, so `POST /api/sessions/anything/register` with
// `{"sessionId": "victim"}` upserts *victim's* row: their machine, their
// transport, their reported hook version, all rewritten by whoever sent the
// request. That is a session-hijack reachable with one field, and the whole
// of it lives in the *order of two spread elements* — a change no type
// checks, no lint catches, and no other test in this suite notices, because
// every other test sends a body that agrees with its path.
//
// So the first case below is that one, written as the attack rather than as
// a happy path: a body that disagrees with the path must lose.

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { HOOK_PROTOCOL } from "@/lib/build-constants";
import { CLI_TRANSPORT_HEADER } from "@/lib/session-transport-header";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("POST /api/sessions/{id}/register", () => {
  const dbName = scratchDatabaseName("session_register_route");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let route: typeof import("@/app/api/sessions/[id]/register/route");

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    route = await import("@/app/api/sessions/[id]/register/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  beforeEach(async () => {
    await prisma.session.deleteMany({});
  });

  function post(
    id: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return route.POST(
      new Request(`http://localhost/api/sessions/${encodeURIComponent(id)}/register`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  describe("the path segment is the session, and the body cannot say otherwise", () => {
    it("REFUSES to let a body's sessionId override the path", async () => {
      // The session-hijack. A pre-existing row stands in for the victim so
      // the assertion is about *their* data surviving, not merely about
      // which id the reply echoes back.
      await prisma.session.create({
        data: {
          id: "victim",
          machine: "victim-machine",
          transport: "mcp_stdio",
          hookVariant: "http",
          hookVersion: HOOK_PROTOCOL.http.current,
        },
      });

      const response = await post("attacker", {
        sessionId: "victim",
        machine: "attacker-machine",
        hookVersion: HOOK_PROTOCOL.http.current,
      });
      expect(response.status).toBe(200);

      // The victim is untouched — same machine, same transport, same version.
      const victim = await prisma.session.findUniqueOrThrow({ where: { id: "victim" } });
      expect(victim.machine).toBe("victim-machine");
      expect(victim.transport).toBe("mcp_stdio");
      expect(victim.hookVersion).toBe(HOOK_PROTOCOL.http.current);

      // …and the row that was actually written is the one the path named.
      const attacker = await prisma.session.findUniqueOrThrow({ where: { id: "attacker" } });
      expect(attacker.machine).toBe("attacker-machine");

      const payload = (await response.json()) as { registration: { sessionId: string } };
      expect(payload.registration.sessionId).toBe("attacker");
    });

    it("registers under the path's id when the body names none", async () => {
      const response = await post("plain-session", { machine: "m" });
      expect(response.status).toBe(200);
      expect(await prisma.session.findUnique({ where: { id: "plain-session" } })).not.toBeNull();
    });

    it("does not create a row under a body-supplied id that the path never named", async () => {
      await post("real-id", { sessionId: "phantom-id", machine: "m" });
      expect(await prisma.session.findUnique({ where: { id: "phantom-id" } })).toBeNull();
      expect(await prisma.session.findUnique({ where: { id: "real-id" } })).not.toBeNull();
    });

    it("keeps a path id that needs encoding intact", async () => {
      // A slash in the id would change the route if it were ever reflected
      // into a path rather than read from the resolved params.
      const id = "crew/member 7";
      const response = await post(id, { machine: "m" });
      expect(response.status).toBe(200);
      expect(await prisma.session.findUnique({ where: { id } })).not.toBeNull();
    });
  });

  describe("the transport the route stamps", () => {
    it("records plain http when no binding stamped itself", async () => {
      await post("no-header", { machine: "m" });
      const row = await prisma.session.findUniqueOrThrow({ where: { id: "no-header" } });
      expect(row.transport).toBe("http");
    });

    it("records cli-http when the command line's binding stamped itself", async () => {
      await post("cli-header", { machine: "m" }, { [CLI_TRANSPORT_HEADER]: "cli-http" });
      const row = await prisma.session.findUniqueOrThrow({ where: { id: "cli-header" } });
      expect(row.transport).toBe("cli_http");
      // The reply describes the hook that transport implies, which is the
      // whole reason the two are told apart at all.
      expect(row.hookVariant).toBe("cli");
    });

    it("IGNORES a header naming a transport that cannot arrive over HTTP", async () => {
      // The allow-list, exercised through the real route rather than the
      // helper: a caller must not be able to register as `cli-direct` — the
      // strongest of the five claims — by sending a header.
      for (const spoofed of ["cli-direct", "mcp-stdio", "mcp-http", "nonsense"]) {
        const id = `spoof-${spoofed}`;
        await post(id, { machine: "m" }, { [CLI_TRANSPORT_HEADER]: spoofed });
        const row = await prisma.session.findUniqueOrThrow({ where: { id } });
        expect(row.transport).toBe("http");
      }
    });

    it("REFUSES a body that names its own transport, rather than ignoring it", async () => {
      // 400, not 422: the operation's schema is `.strict()`, so an unknown
      // field is `invalid_input` (a malformed request) rather than
      // `guard_rejected` (a rule declining a well-formed one). The
      // distinction matters to a client deciding whether to retry.
      const response = await post("body-transport", { machine: "m", transport: "cli-direct" });
      expect(response.status).toBe(400);
      expect(await prisma.session.findUnique({ where: { id: "body-transport" } })).toBeNull();
    });
  });

  describe("what the route does with a body it cannot use", () => {
    it("answers 400 for a body that is not JSON at all", async () => {
      const response = await route.POST(
        new Request("http://localhost/api/sessions/bad-json/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
        { params: Promise.resolve({ id: "bad-json" }) },
      );
      expect(response.status).toBe(400);
      expect(await prisma.session.findUnique({ where: { id: "bad-json" } })).toBeNull();
    });

    it("refuses a JSON body that is not an object with a typed error, not a crash", async () => {
      // The route coerces a non-object body to `{}` rather than spreading a
      // string, so what reaches the operation is `{ sessionId }` alone.
      // `machine` is required, so it refuses on the schema — and the point
      // is that it is a *typed* refusal (400 `invalid_input`) rather than an
      // unhandled throw surfacing as a 500.
      const response = await route.POST(
        new Request("http://localhost/api/sessions/scalar-body/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify("just a string"),
        }),
        { params: Promise.resolve({ id: "scalar-body" }) },
      );
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(payload.error.code).toBe("invalid_input");
      expect(payload.error.fields).toContain("machine");
      expect(await prisma.session.findUnique({ where: { id: "scalar-body" } })).toBeNull();
    });

    it("reports the version verdict rather than silently accepting", async () => {
      const response = await post("no-version", { machine: "m" });
      const payload = (await response.json()) as {
        registration: { mayClaim: boolean; version: { verdict: string } };
      };
      // The version verdict is "unregistered" — that fact is still reported
      // in full. But `mayClaim` answers a different question: under the
      // shipped default (`hook.require_registration_to_claim` off, unset by
      // this test), a claim from this session would in fact succeed, so the
      // handshake must say so rather than echo the version verdict alone.
      expect(payload.registration.mayClaim).toBe(true);
      expect(payload.registration.version.verdict).toBe("unregistered");
    });
  });
});
