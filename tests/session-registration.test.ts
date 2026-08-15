// The registration handshake end to end, against a real Postgres —
// MILESTONES.md #43, SCHEMA.md §21.
//
// Two things are proved here that the pure unit tests
// (`sessions-version-rule.test.ts`) structurally cannot:
//
//   1. **The transport is stamped by the adapter and not by the caller.** A
//      payload naming a transport is refused, and the row that lands carries
//      whatever the adapter said it was. That claim is about the operation's
//      schema and the context it is handed, so it needs the operation.
//   2. **`claim` actually refuses.** The version rule returning
//      `mayClaim: false` is worth nothing if nothing consults it, and "the
//      guard is wired in" is precisely the kind of thing a happy-path suite
//      never notices is missing. So every refusal below is asserted through
//      `claim` itself, with the assignment table checked afterwards to prove
//      the refusal happened *before* the write rather than being reported
//      after one.
//
// **The `claiming` block sets `hook.require_registration_to_claim` itself,
// in both positions, rather than inheriting whatever the registry's default
// happens to be.** The refusals only exist when the setting is on, so a
// block that never named it would be asserting them against a default — and
// the day that default moves, every refusal here stops being exercised while
// the file still reports a full row of passing tests. A posture a test
// depends on is part of that test's setup. The positive case is asserted the
// same way and with the setting off, because "an unregistered session can own
// work" is the deployed behaviour and it deserves the same end-to-end proof
// the refusals get, not just a unit test against a fake context.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { HOOK_PROTOCOL } from "@/lib/build-constants";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("session registration and the claim refusal", () => {
  const dbName = scratchDatabaseName("session_registration");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let service: typeof import("@/lib/service/live").service;
  let settingsCache: typeof import("@/lib/service/live").settingsCache;
  let itemCounter = 0;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    process.env.DATABASE_URL = scratchUrl;
    ({ service, settingsCache } = await import("@/lib/service/live"));
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "reg-area", displayName: "Registration area" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  beforeEach(async () => {
    await prisma.assignment.deleteMany({});
    await prisma.session.deleteMany({});
  });

  async function newItem(): Promise<string> {
    itemCounter += 1;
    const id = `reg-item-${itemCounter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: `Item ${itemCounter}`,
        body: "A test item.",
        state: "on_deck",
        originType: "auto",
        area: "reg-area",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  /** Registers over one transport, exactly as an adapter would. */
  async function register(
    transport: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return (await service.call("register_session", input, {
      caller: { transport },
    })) as unknown as Record<string, unknown>;
  }

  async function attemptClaim(sessionId: string, itemId: string): Promise<unknown> {
    return service.call(
      "claim",
      {
        itemId,
        role: "builder",
        holderType: "agent",
        holderId: "some-agent",
        sessionId,
        machine: "a-machine",
      },
      { caller: { transport: "http", sessionId } },
    );
  }

  /**
   * Writes one settings override row, bumps the revision, and drops the
   * held snapshot — the same two statements `put_setting`'s handler issues
   * (`src/lib/service/operations/put-setting.ts`) followed by the documented
   * "immediate in the process that made the change" escape hatch
   * (`src/lib/settings/cache.ts`).
   *
   * The invalidate is not optional. `service/live.ts` composes the runtime
   * with a `SettingsCache` that serves a held snapshot for up to
   * `revalidateAfterMs`, so without it the service would keep reading the
   * value from before the write and every assertion below would be about the
   * previous posture rather than the one it just set.
   */
  async function putSettingRow(key: string, value: unknown): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "settings" ("key", "value", "updatedByType", "updatedById")
       VALUES ($1, $2::jsonb, 'system'::"ActorType", NULL)
       ON CONFLICT ("key") DO UPDATE
         SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP`,
      key,
      JSON.stringify(value),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "settings_revision" SET "revision" = "revision" + 1 WHERE "id" = 1`,
    );
    settingsCache.invalidate();
  }

  async function clearSettingRow(key: string): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "settings" WHERE "key" = $1`, key);
    await prisma.$executeRawUnsafe(
      `UPDATE "settings_revision" SET "revision" = "revision" + 1 WHERE "id" = 1`,
    );
    settingsCache.invalidate();
  }

  describe("the transport is a capability signal, not a self-report", () => {
    it("records the transport the adapter stamped", async () => {
      for (const transport of ["cli-direct", "cli-http", "mcp-stdio", "mcp-http", "http"]) {
        const sessionId = `s-${transport}`;
        const reply = await register(transport, { sessionId, machine: "m" });
        expect(reply.transport).toBe(transport);

        const row = await prisma.session.findUnique({ where: { id: sessionId } });
        expect(row?.transport).toBe(transport.replace("-", "_"));
      }
    });

    it("REFUSES a payload that names its own transport", async () => {
      // `.strict()` does the enforcing: a field nobody reads must be
      // rejected rather than silently dropped, or a client keeps sending it
      // believing it means something.
      await expect(
        register("http", { sessionId: "s-liar", machine: "m", transport: "cli-direct" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await prisma.session.findUnique({ where: { id: "s-liar" } })).toBeNull();
    });

    it("REFUSES a call from an adapter that stamped nothing", async () => {
      // A door that has not been taught to say which door it is carries no
      // capability signal at all, and defaulting it would invent one.
      await expect(
        service.call("register_session", { sessionId: "s-anon", machine: "m" }, {}),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await prisma.session.findUnique({ where: { id: "s-anon" } })).toBeNull();
    });

    it("REFUSES a transport this build does not have", async () => {
      // `cli` in particular: the name the command line stamped before the
      // two bindings were told apart. Accepting it would silently record a
      // session as one of two different capability claims.
      for (const bogus of ["cli", "carrier-pigeon", ""]) {
        await expect(register(bogus, { sessionId: "s-bogus", machine: "m" })).rejects.toMatchObject(
          { code: "invalid_input" },
        );
      }
      expect(await prisma.session.findUnique({ where: { id: "s-bogus" } })).toBeNull();
    });
  });

  describe("the reply names the matching hook variant", () => {
    it("tells a command-line registration about the command-line hook", async () => {
      for (const transport of ["cli-direct", "cli-http"]) {
        const reply = await register(transport, { sessionId: `hv-${transport}`, machine: "m" });
        expect(reply.hookVariant).toBe("cli");
        expect(reply.hookVariantOverridden).toBe(false);
        expect(String(reply.hook)).toContain("command-line");
        expect(reply.protocol).toEqual({
          current: HOOK_PROTOCOL.cli.current,
          minSupported: HOOK_PROTOCOL.cli.minSupported,
        });
      }
    });

    it("tells a server-reached registration about the http hook", async () => {
      for (const transport of ["mcp-stdio", "mcp-http", "http"]) {
        const reply = await register(transport, { sessionId: `hv-${transport}`, machine: "m" });
        expect(reply.hookVariant).toBe("http");
        expect(String(reply.hook)).toContain("http");
        expect(reply.protocol).toEqual({
          current: HOOK_PROTOCOL.http.current,
          minSupported: HOOK_PROTOCOL.http.minSupported,
        });
      }
    });

    it("honours an explicit override and records it as one", async () => {
      const reply = await register("http", {
        sessionId: "hv-override",
        machine: "m",
        hookVariant: "cli",
      });
      expect(reply.hookVariant).toBe("cli");
      expect(reply.hookVariantOverridden).toBe(true);

      const row = await prisma.session.findUnique({ where: { id: "hv-override" } });
      expect(row?.hookVariant).toBe("cli");
      expect(row?.hookVariantOverridden).toBe(true);
      // The transport is still what the adapter observed — an override
      // changes the conclusion drawn from it, never the observation.
      expect(row?.transport).toBe("http");
    });

    it("compares an overridden variant against THAT variant's range", async () => {
      const reply = await register("http", {
        sessionId: "hv-override-range",
        machine: "m",
        hookVariant: "cli",
        hookVersion: HOOK_PROTOCOL.cli.current,
      });
      expect(reply.protocol).toEqual({
        current: HOOK_PROTOCOL.cli.current,
        minSupported: HOOK_PROTOCOL.cli.minSupported,
      });
    });
  });

  describe("re-registration is a refresh", () => {
    it("keeps registeredAt and moves lastSeenAt", async () => {
      await register("http", { sessionId: "s-again", machine: "m1", hookVersion: 1 });
      const first = await prisma.session.findUniqueOrThrow({ where: { id: "s-again" } });

      await new Promise((resolve) => setTimeout(resolve, 25));
      await register("cli-direct", { sessionId: "s-again", machine: "m2", hookVersion: 2 });
      const second = await prisma.session.findUniqueOrThrow({ where: { id: "s-again" } });

      expect(second.registeredAt.getTime()).toBe(first.registeredAt.getTime());
      expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
      // A second registration may legitimately report a different version —
      // that is what updating looks like — and a different transport.
      expect(second.hookVersion).toBe(2);
      expect(second.transport).toBe("cli_direct");
      expect(second.machine).toBe("m2");
    });
  });

  describe("claiming under the strict posture", () => {
    // Set deliberately rather than inherited: see this file's header. The
    // refusals below are only reachable with this on, so the block that
    // asserts them is the block that has to establish it.
    beforeEach(async () => {
      await putSettingRow("hook.require_registration_to_claim", true);
    });

    afterEach(async () => {
      await clearSettingRow("hook.require_registration_to_claim");
    });

    it("lets a registered, current session claim", async () => {
      const itemId = await newItem();
      await register("http", {
        sessionId: "ok-session",
        machine: "m",
        hookVersion: HOOK_PROTOCOL.http.current,
      });
      const assignment = (await attemptClaim("ok-session", itemId)) as { id: string };
      expect(assignment.id).toBeTruthy();
      expect(await prisma.assignment.count({ where: { sessionId: "ok-session" } })).toBe(1);
    });

    it("REFUSES a session that never registered", async () => {
      const itemId = await newItem();
      await expect(attemptClaim("ghost-session", itemId)).rejects.toMatchObject({
        code: "forbidden",
      });
      // The refusal happened before the write, so nothing was displaced.
      expect(await prisma.assignment.count({ where: { itemId } })).toBe(0);
    });

    it("REFUSES a session that registered without naming a version", async () => {
      const itemId = await newItem();
      await register("http", { sessionId: "no-version", machine: "m" });
      await expect(attemptClaim("no-version", itemId)).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(await prisma.assignment.count({ where: { itemId } })).toBe(0);
    });

    it("REFUSES a session below min_supported", async () => {
      const itemId = await newItem();
      // Written straight to the table: the operation's schema refuses a
      // negative version, and this build's `minSupported` is 1, so a row
      // below the minimum is not reachable through `register_session` while
      // the two are equal. The rule still has to hold for it — once
      // `minSupported` is raised in a release, every already-registered
      // session below the new floor is exactly this row, and it arrived
      // legitimately.
      await prisma.session.create({
        data: {
          id: "ancient-session",
          machine: "m",
          transport: "http",
          hookVariant: "http",
          hookVersion: HOOK_PROTOCOL.http.minSupported - 1,
        },
      });

      await expect(attemptClaim("ancient-session", itemId)).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(await prisma.assignment.count({ where: { itemId } })).toBe(0);
    });

    it("names what to do in the refusal rather than just refusing", async () => {
      // And names it for the surface this caller is actually on. The claim
      // above arrives over `http`, so the refusal points at the
      // `register_session` endpoint rather than at a terminal command the
      // reader has no terminal for (MILESTONES.md #111). This is the
      // end-to-end proof that the transport reaches the wording: the
      // per-surface unit assertions are in `describe-tool.test.ts`, but
      // only a real service call exercises the threading.
      const error = await attemptClaim("ghost-2", await newItem()).then(
        () => {
          throw new Error("Expected the claim to be refused.");
        },
        (caught: unknown) => caught as Error,
      );
      expect(error.message).toContain("register_session");
      // The negative half, asserted on the captured message rather than
      // through a `.not.toThrow()` — which passes for a call that rejects
      // with anything else at all, and so could not fail here.
      expect(error.message).not.toContain("standup session register");
    });

    it("does NOT refuse an advisory (below current, at or above min_supported)", async () => {
      // The entire difference between the two numbers. If this ever starts
      // refusing, a routine version bump becomes a fleet-wide outage.
      const itemId = await newItem();
      await prisma.session.create({
        data: {
          id: "old-but-fine",
          machine: "m",
          transport: "http",
          hookVariant: "http",
          hookVersion: HOOK_PROTOCOL.http.minSupported,
        },
      });
      const assignment = (await attemptClaim("old-but-fine", itemId)) as { id: string };
      expect(assignment.id).toBeTruthy();
    });

    it("does not refuse a session running a NEWER hook than this build", async () => {
      // A rolling upgrade puts a new client in front of an old server;
      // `current` is what this build speaks, not a ceiling on what it talks
      // to.
      const itemId = await newItem();
      await register("http", {
        sessionId: "from-the-future",
        machine: "m",
        hookVersion: HOOK_PROTOCOL.http.current + 5,
      });
      const assignment = (await attemptClaim("from-the-future", itemId)) as { id: string };
      expect(assignment.id).toBeTruthy();
    });

    it("REFUSES on the item's registration, not on the claimer's other sessions", async () => {
      // A registered session does not vouch for an unregistered one that
      // happens to share a machine — the check is per session id.
      const itemId = await newItem();
      await register("http", {
        sessionId: "registered-sibling",
        machine: "shared-machine",
        hookVersion: HOOK_PROTOCOL.http.current,
      });
      await expect(attemptClaim("unregistered-sibling", itemId)).rejects.toMatchObject({
        code: "forbidden",
      });
    });

    it("still reports a bad item id as not_found rather than as a registration problem", async () => {
      // Ordering: the caller can act on a typo'd id right now and cannot
      // act on their registration in that moment, so the typo is the more
      // useful sentence.
      await expect(attemptClaim("also-a-ghost", "no-such-item")).rejects.toMatchObject({
        code: "not_found",
      });
    });
  });

  describe("claiming under the shipped posture", () => {
    // The mirror of the block above, and the half that is actually deployed:
    // with the setting off, running no hook costs a session nothing. Asserted
    // through the live service rather than against a fake context, because
    // the claim reaching the assignment table is the whole of what "ownership
    // does not depend on the hook" means — a unit test on
    // `assertSessionMayClaim` alone would still pass if some caller between
    // the operation and the table refused the session for the same reason.
    beforeEach(async () => {
      await putSettingRow("hook.require_registration_to_claim", false);
    });

    afterEach(async () => {
      await clearSettingRow("hook.require_registration_to_claim");
    });

    it("lets a session that never registered claim", async () => {
      const itemId = await newItem();
      const assignment = (await attemptClaim("unhooked-session", itemId)) as { id: string };
      expect(assignment.id).toBeTruthy();
      expect(await prisma.assignment.count({ where: { sessionId: "unhooked-session" } })).toBe(1);
      // No registration was invented on the way through: the session is a
      // ghost before the claim and still one after it, which is what makes
      // its tool calls unobserved rather than merely unenforced.
      expect(await prisma.session.findUnique({ where: { id: "unhooked-session" } })).toBeNull();
    });

    it("lets a session below min_supported claim", async () => {
      // The other refusal the strict posture makes: off, an out-of-date hook
      // is information about which signals to expect, not grounds to refuse.
      const itemId = await newItem();
      await prisma.session.create({
        data: {
          id: "ancient-but-allowed",
          machine: "m",
          transport: "http",
          hookVariant: "http",
          hookVersion: HOOK_PROTOCOL.http.minSupported - 1,
        },
      });
      const assignment = (await attemptClaim("ancient-but-allowed", itemId)) as { id: string };
      expect(assignment.id).toBeTruthy();
    });

    it("still reports a bad item id as not_found", async () => {
      // The claim's own checks are untouched by the posture — turning the
      // gate off relaxes one rule, not the operation.
      await expect(attemptClaim("another-ghost", "no-such-item")).rejects.toMatchObject({
        code: "not_found",
      });
    });
  });

  describe("what the reply says about claiming", () => {
    it("says a current session may claim", async () => {
      const reply = await register("http", {
        sessionId: "reply-ok",
        machine: "m",
        hookVersion: HOOK_PROTOCOL.http.current,
      });
      expect(reply.mayClaim).toBe(true);
      expect((reply.version as { verdict: string }).verdict).toBe("current");
    });

    it("says a session that named no version may NOT claim", async () => {
      const reply = await register("http", { sessionId: "reply-none", machine: "m" });
      expect(reply.mayClaim).toBe(false);
      expect((reply.version as { verdict: string }).verdict).toBe("unregistered");
    });
  });
});
