// Server-side crew naming — SCHEMA.md §9, §18, §21 — against a real
// Postgres. A session's crew name is assigned as a side effect of
// `register_session` (every session's first call) and `claim` (the call that
// takes ownership on behalf of a holder), through `ensureNameForSession`
// (`@/lib/agent-names`) — never by a separate naming request.
//
// **What this file proves that `tests/agent-names.test.ts` and
// `tests/get-crew-name-operation.test.ts` do not.** Those two prove
// `handOutName`'s own atomicity and `get_crew_name`'s own input handling —
// unchanged here, not re-proven. What is new is the *composition*:
// `ensureNameForSession`'s "keep what you already hold" read-then-maybe-write
// wired into two operations that were not naming callers before, and reached
// through the one door every adapter uses (`runtime.call`), not by calling
// the library function directly.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { HOOK_PROTOCOL } from "@/lib/build-constants";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("crew naming, assigned server-side — against Postgres", () => {
  const dbName = scratchDatabaseName("crew_naming_server_side");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let nameCounter = 0;
  let itemCounter = 0;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    await prisma.area.create({ data: { id: "naming-area", displayName: "Naming area" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  beforeEach(async () => {
    await prisma.assignment.deleteMany({});
    await prisma.session.deleteMany({});
    await prisma.agent.deleteMany({});
    nameCounter = 0;
  });

  /** Seeds `count` fresh, unheld, unretired agent names and returns them. */
  async function seedNames(count: number, prefix = "agent"): Promise<string[]> {
    const names = Array.from({ length: count }, () => {
      nameCounter += 1;
      return `${prefix}-${nameCounter}`;
    });
    await prisma.agent.createMany({ data: names.map((name) => ({ name })) });
    return names;
  }

  async function seedItem(): Promise<string> {
    itemCounter += 1;
    const id = `naming-item-${itemCounter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: "t",
        body: "b",
        state: "on_deck",
        originType: "auto",
        area: "naming-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function register(
    sessionId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return (await runtime.call(
      "register_session",
      { sessionId, machine: "m", hookVersion: HOOK_PROTOCOL.http.current, ...overrides },
      { caller: { transport: "http" } },
    )) as unknown as Record<string, unknown>;
  }

  // -------------------------------------------------------------------------
  // register_session assigns a name
  // -------------------------------------------------------------------------

  describe("register_session", () => {
    it("assigns an available name on first registration", async () => {
      const [name] = await seedNames(1);
      const reply = await register("reg-s1");
      expect(reply.crewName).toBe(name);

      const row = await prisma.agent.findUniqueOrThrow({ where: { name: name! } });
      expect(row.heldBySessionId).toBe("reg-s1");
    });

    it("re-registering the SAME session keeps its existing name rather than drawing a second one", async () => {
      await seedNames(2, "keep");
      const first = await register("reg-keep");
      const firstName = first.crewName;
      expect(firstName).toBeTruthy();

      // Re-register (a reconnect) — SCHEMA.md §21's own "re-registration is
      // a refresh" — and confirm the name did not change and the pool was
      // not drawn from a second time.
      const second = await register("reg-keep", { machine: "m2" });
      expect(second.crewName).toBe(firstName);

      const heldCount = await prisma.agent.count({
        where: { heldBySessionId: "reg-keep" },
      });
      // Mutation evidence: if `ensureNameForSession` drew a fresh name on
      // every call instead of checking `nameHeldBy` first, this session
      // would hold TWO rows (its first name, orphaned, plus a second) —
      // this assertion is what catches that, not merely "a name came back".
      expect(heldCount).toBe(1);
    });

    it("two DIFFERENT sessions never receive the same name, even racing for the last one", async () => {
      await seedNames(1, "race-reg");
      const [a, b] = await Promise.all([register("reg-race-a"), register("reg-race-b")]);
      const names = [a.crewName, b.crewName].filter((n): n is string => n !== null);
      // Exactly one of the two got the single available name; the other got
      // `null` (pool exhausted) rather than the SAME name.
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBeLessThanOrEqual(1);
    });

    it("registration still SUCCEEDS when the name pool is exhausted — naming is a courtesy, not a precondition", async () => {
      // No names seeded in this scratch DB at this point in the file.
      const reply = await register("reg-no-names");
      expect(reply.crewName).toBeNull();
      // The registration itself went through — the session row exists and
      // the reply carries the ordinary registration fields.
      expect(reply.sessionId).toBe("reg-no-names");
      expect(reply.mayClaim).toBe(true);
      const row = await prisma.session.findUniqueOrThrow({ where: { id: "reg-no-names" } });
      expect(row.id).toBe("reg-no-names");
    });
  });

  // -------------------------------------------------------------------------
  // claim returns a subagent's assigned name
  // -------------------------------------------------------------------------

  describe("claim", () => {
    function claimInput(itemId: string, overrides: Record<string, unknown> = {}) {
      return {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "crew-member",
        sessionId: "claim-session",
        machine: "laptop",
        ...overrides,
      };
    }

    it("names the claiming session and returns crewName on the same call — no second round trip", async () => {
      const [name] = await seedNames(1, "claim");
      await register("claim-session");
      const itemId = await seedItem();

      const assignment = (await runtime.call("claim", claimInput(itemId))) as {
        crewName: string | null;
        sessionId: string;
      };
      expect(assignment.crewName).toBe(name);
      expect(assignment.sessionId).toBe("claim-session");
    });

    it("a session already named by register_session keeps that name on claim, rather than drawing a second one", async () => {
      await seedNames(2, "already");
      const reg = await register("already-named-session");
      const registeredName = reg.crewName as string;
      const itemId = await seedItem();

      const assignment = (await runtime.call(
        "claim",
        claimInput(itemId, { sessionId: "already-named-session" }),
      )) as { crewName: string | null };
      expect(assignment.crewName).toBe(registeredName);

      const heldCount = await prisma.agent.count({
        where: { heldBySessionId: "already-named-session" },
      });
      expect(heldCount).toBe(1);
    });

    it("does NOT name a person holder — a human is named by holderId already", async () => {
      const [name] = await seedNames(1, "person");
      // Registered WITHOUT going through register_session — that operation
      // names every session it registers regardless of role, which would
      // hand out the one seeded name before claim ever runs and make this
      // case indistinguishable from an already-exhausted pool. Registration
      // itself is not what's under test here, so the session is registered
      // directly against the table, the same way tests/helpers/
      // register-sessions.ts does for files whose subject is something else.
      await prisma.session.upsert({
        where: { id: "person-session" },
        create: {
          id: "person-session",
          machine: "m",
          transport: "http",
          hookVariant: "http",
          hookVersion: HOOK_PROTOCOL.http.current,
        },
        update: {},
      });
      const itemId = await seedItem();

      const assignment = (await runtime.call("claim", {
        itemId,
        role: "builder",
        holderType: "person",
        holderId: "some-person-id",
        sessionId: "person-session",
        machine: "laptop",
      })) as { crewName: string | null };
      expect(assignment.crewName).toBeNull();

      // The pool was not touched by claim — the seeded name is still
      // unheld, available for an agent that actually needs one.
      const row = await prisma.agent.findUniqueOrThrow({ where: { name: name! } });
      expect(row.heldBySessionId).toBeNull();
    });

    it("claim still succeeds when the name pool is exhausted — crewName is null, not a thrown error", async () => {
      // No names seeded in this scratch DB at this point in the file.
      await register("claim-no-names");
      const itemId = await seedItem();

      const assignment = (await runtime.call(
        "claim",
        claimInput(itemId, { sessionId: "claim-no-names" }),
      )) as { crewName: string | null; id: string };
      expect(assignment.crewName).toBeNull();
      expect(assignment.id).toBeTruthy();
    });

    it("two subagents claiming concurrently under a scarce pool never receive the same name", async () => {
      await seedNames(1, "claim-race");
      await register("claim-race-a");
      await register("claim-race-b");
      const itemA = await seedItem();
      const itemB = await seedItem();

      const [a, b] = await Promise.all([
        runtime.call("claim", claimInput(itemA, { sessionId: "claim-race-a" })),
        runtime.call("claim", claimInput(itemB, { sessionId: "claim-race-b" })),
      ]);
      const names = [
        (a as { crewName: string | null }).crewName,
        (b as { crewName: string | null }).crewName,
      ].filter((n): n is string => n !== null);
      expect(new Set(names).size).toBe(names.length);
      expect(names.length).toBeLessThanOrEqual(1);
    });
  });
});
