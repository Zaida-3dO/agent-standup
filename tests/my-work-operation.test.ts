// `my_work` against a real Postgres — SCHEMA.md §2, §18, MILESTONES.md #28.
// Same shape as tests/orientation-operation.test.ts and
// tests/items-operations.test.ts: a real ServiceRuntime against a scratch
// database, because the property this operation exists to prove — that two
// sessions can hold the same item in two different roles, and `my_work`
// reports each session's OWN role rather than some item-level fact — is
// exactly what an in-memory double cannot be trusted to decide honestly.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { claimItem, type ClaimInput } from "@/lib/claims";
import { isoOrString } from "@/lib/service/operations/my-work";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { registerSessions } from "./helpers/register-sessions";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

// Unit coverage for `isoOrString` — the `claimedAt`/`lastActive` field
// mapping — run unconditionally (no TEST_DATABASE_URL needed), because the
// DB-backed tests below can only ever exercise the `Date` branch (Postgres
// `timestamptz` always deserializes to a JS `Date` via `$queryRawUnsafe`).
// Both branches the function actually has:
//   1. a `Date` input -> `.toISOString()`
//   2. an already-a-string input -> returned unchanged (the `Date | string`
//      signature's other half; nothing else the function does).
describe("isoOrString (my_work's claimedAt/lastActive mapping)", () => {
  it("claimedAt: converts a Date input to its ISO string", () => {
    const d = new Date("2026-03-14T09:26:53.589Z");
    expect(isoOrString(d)).toBe("2026-03-14T09:26:53.589Z");
  });

  it("lastActive: passes an already-a-string input through unchanged", () => {
    // A gutted function body (one that ignores `value` and always returns a
    // fixed literal) fails this assertion by name, since it would return
    // that literal instead of the input.
    const s = "2026-07-01T00:00:00.000Z";
    expect(isoOrString(s)).toBe(s);
  });
});

describeIfDb("my_work against Postgres", () => {
  const dbName = scratchDatabaseName("my_work_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function makeItem(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    return (await runtime.call("create_item", {
      title: "my_work subject",
      body: "x",
      area: "my-work-area",
      originType: "auto",
      ...overrides,
    })) as { id: string };
  }

  async function claim(input: ClaimInput) {
    return prisma.$transaction((tx) => claimItem(tx, input));
  }

  it("refuses a sessionId that fails validation — empty string", async () => {
    const error = await runtime.call("my_work", { sessionId: "" }).catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("invalid_input");
  });

  it("a session holding nothing returns an empty list, not an error", async () => {
    const result = (await runtime.call("my_work", {
      sessionId: "session-holds-nothing",
    })) as { items: readonly unknown[] };
    expect(result.items).toEqual([]);
  });

  it("reports a session that has never registered as unhooked", async () => {
    // The gap this closes: a session with no hook can claim and do work, and
    // nothing downstream could tell "no rule could have fired here, because
    // nothing was watching" from "a rule fired and found nothing wrong". A
    // reviewer trusting that policy was enforced on such a session is
    // trusting something that was never true.
    const result = (await runtime.call("my_work", {
      sessionId: "session-never-registered",
    })) as { hooked: boolean };
    expect(result.hooked).toBe(false);
  });

  it("reports a session registered without a version as unhooked too", async () => {
    // A registered session that reported no version has no hook this
    // installation has heard from, exactly as an unregistered one does. A
    // reader asking "was anything watching" is owed the same answer for
    // both, so the absent row and the null column collapse deliberately.
    await prisma.session.upsert({
      where: { id: "session-registered-no-version" },
      create: {
        id: "session-registered-no-version",
        machine: "laptop",
        transport: "http",
        hookVariant: "http",
        hookVersion: null,
      },
      update: { hookVersion: null },
    });

    const result = (await runtime.call("my_work", {
      sessionId: "session-registered-no-version",
    })) as { hooked: boolean };
    expect(result.hooked).toBe(false);
  });

  it("reports a session that reported a hook version as hooked", async () => {
    // The other direction, which is what stops the field being a constant.
    // A mutant hardcoding `false` passes both tests above and fails here.
    await registerSessions(prisma, ["session-with-hook"]);

    const result = (await runtime.call("my_work", { sessionId: "session-with-hook" })) as {
      hooked: boolean;
    };
    expect(result.hooked).toBe(true);
  });

  // ── The declaration, checked against whether anything bore it out ─────
  //
  // `hooked` reports what the session said. On a deployment where the hook
  // is provisioned per machine and fails open, a session can say it has one
  // and never run it — so `hooked: true` alone cannot be read as "something
  // was watching", which is the very thing `hooked` exists to let a reader
  // decide.

  it("reports a session that declared a hook and has never sent a tool call as silent", async () => {
    // The misreporting shape: a registration naming a version, and no
    // telemetry from it anywhere. `hooked` stays `true` — the declaration
    // is a real fact and this does not overwrite it — while the new field
    // says nothing corroborates it. Hardcoding `declaredHookSilent: false`
    // fails this.
    await registerSessions(prisma, ["session-declared-silent"]);

    const result = (await runtime.call("my_work", { sessionId: "session-declared-silent" })) as {
      hooked: boolean;
      declaredHookSilent: boolean;
    };
    expect(result.hooked).toBe(true);
    expect(result.declaredHookSilent).toBe(true);
  });

  it("stops reporting a declared session as silent once one tool call arrives", async () => {
    // The controlled comparison, and what stops the field being a constant
    // `true` for every registered session. One `ToolCall` row is proof the
    // hook runs; the correlation is on `sessionId` alone, so it counts
    // whether or not the session holds a claim. Dropping the `EXISTS`
    // subquery, or ignoring its result, passes the test above and fails
    // this one.
    await registerSessions(prisma, ["session-declared-and-flushed"]);
    await prisma.toolCall.create({
      data: { sessionId: "session-declared-and-flushed", tool: "Read", paths: [] },
    });

    const result = (await runtime.call("my_work", {
      sessionId: "session-declared-and-flushed",
    })) as { hooked: boolean; declaredHookSilent: boolean };
    expect(result.hooked).toBe(true);
    expect(result.declaredHookSilent).toBe(false);
  });

  it("does not report an unregistered session as silent — it declared nothing", async () => {
    // A session with no declaration has nothing to contradict, so flagging
    // it would blame it for being honest about having no hook. Dropping the
    // `hooked &&` guard makes this `true` and fails.
    const result = (await runtime.call("my_work", { sessionId: "session-never-registered" })) as {
      hooked: boolean;
      declaredHookSilent: boolean;
    };
    expect(result.hooked).toBe(false);
    expect(result.declaredHookSilent).toBe(false);
  });

  it("answers whether the session is hooked even when it holds nothing", async () => {
    // The case a join onto the assignments would have lost. A session
    // holding no work still has a hook or still does not, and that is
    // exactly the session a reviewer may be looking at — an empty item list
    // must not silently take the field with it.
    await registerSessions(prisma, ["session-hooked-idle"]);

    const result = (await runtime.call("my_work", { sessionId: "session-hooked-idle" })) as {
      items: readonly unknown[];
      hooked: boolean;
    };
    expect(result.items).toEqual([]);
    expect(result.hooked).toBe(true);
  });

  it("carries roleCustom through for a role:'custom' assignment", async () => {
    // Single-character mutation this catches: swap `a."roleCustom"` for
    // `a."role"` (or drop the alias) in my-work.ts's SELECT — roleCustom
    // would then read back null or the wrong column, failing this
    // assertion specifically (role stays correctly "custom" either way,
    // so a test that only checked `role` would miss this).
    const item = await makeItem({ title: "Custom role" });
    await claim({
      itemId: item.id,
      role: "custom",
      roleCustom: "domain-expert",
      holderType: "agent",
      holderId: "crew-custom",
      sessionId: "session-custom-role",
      machine: "laptop",
    });

    const result = (await runtime.call("my_work", { sessionId: "session-custom-role" })) as {
      items: readonly { assignment: { role: string; roleCustom: string | null } }[];
    };
    expect(result.items[0]?.assignment.role).toBe("custom");
    expect(result.items[0]?.assignment.roleCustom).toBe("domain-expert");
  });

  it("returns the item this session holds, with its OWN role attached", async () => {
    const item = await makeItem({ title: "Held by one session" });
    await claim({
      itemId: item.id,
      role: "reviewer",
      holderType: "agent",
      holderId: "crew-member-r",
      sessionId: "session-single-holder",
      machine: "laptop",
    });

    const result = (await runtime.call("my_work", { sessionId: "session-single-holder" })) as {
      items: readonly { item: { id: string }; assignment: { role: string; sessionId?: string } }[];
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.item.id).toBe(item.id);
    expect(result.items[0]?.assignment.role).toBe("reviewer");
  });

  it("THE central case — two sessions hold the SAME item in DIFFERENT roles, and my_work reports each session's own role", async () => {
    // This is the case AC3/AC4 require: without it, session-scoping and
    // role-reporting are both untested, because a single-session case
    // cannot distinguish "my_work filters by session" from "my_work just
    // returns the item's one role" (an item has no single "role" — SCHEMA.md
    // §2's whole uniqueness discussion is that several roles can be live on
    // one item at once).
    const item = await makeItem({ title: "Shared by two roles" });
    await claim({
      itemId: item.id,
      role: "orchestrator",
      holderType: "agent",
      holderId: "crew-orchestrator",
      sessionId: "session-shared-orch",
      machine: "laptop",
    });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "crew-builder",
      sessionId: "session-shared-builder",
      parentSessionId: "session-shared-orch",
      rootSessionId: "session-shared-orch",
      machine: "laptop",
    });

    const orchWork = (await runtime.call("my_work", { sessionId: "session-shared-orch" })) as {
      items: readonly { item: { id: string }; assignment: { role: string } }[];
    };
    const builderWork = (await runtime.call("my_work", {
      sessionId: "session-shared-builder",
    })) as { items: readonly { item: { id: string }; assignment: { role: string } }[] };

    // Same item, both times.
    expect(orchWork.items).toHaveLength(1);
    expect(builderWork.items).toHaveLength(1);
    expect(orchWork.items[0]?.item.id).toBe(item.id);
    expect(builderWork.items[0]?.item.id).toBe(item.id);

    // Different role, per session — the fact a list filter over `items`
    // cannot express, because `items` carries no role column at all.
    // Single-character mutation this catches: swap `a."role"` for
    // `a."roleCustom"` (or any other assignment column) in my-work.ts's
    // SELECT — this exact pair of assertions would then read the wrong
    // column and fail.
    expect(orchWork.items[0]?.assignment.role).toBe("orchestrator");
    expect(builderWork.items[0]?.assignment.role).toBe("builder");
  });

  it("PROOF this is not achievable as a list_items filter: list_items has no role field to filter by or return", async () => {
    // Structural proof, not just a behavioural one: list_items' own input
    // schema (list-items.ts) has no `sessionId` or `role` parameter, and its
    // output (`ItemRecord`, items/row.ts) has no role column — there is no
    // parameterisation of list_items that could produce "this session's role
    // on this item", because that fact lives on `assignments`, not `items`.
    const item = await makeItem({ title: "No role on the item itself" });
    await claim({
      itemId: item.id,
      role: "scout",
      holderType: "agent",
      holderId: "crew-scout",
      sessionId: "session-proof",
      machine: "laptop",
    });

    const listed = (await runtime.call("list_items", {
      area: "my-work-area",
    })) as unknown as {
      items: readonly Record<string, unknown>[];
    };
    const thisItem = listed.items.find((i) => i.id === item.id);
    expect(thisItem).toBeDefined();
    // No key on the returned item shape ever names a role, a session, or an
    // assignment — proving the information my_work supplies is categorically
    // absent from list_items' output, not merely unfiltered.
    expect(Object.keys(thisItem!)).not.toContain("role");
    expect(Object.keys(thisItem!)).not.toContain("assignment");
    expect(Object.keys(thisItem!)).not.toContain("sessionId");
  });

  it("a RELEASED assignment is not reported — session-scoped means LIVE, not 'ever held'", async () => {
    const item = await makeItem({ title: "Released work" });
    await claim({
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "crew-member",
      sessionId: "session-released",
      machine: "laptop",
    });
    await prisma.$executeRawUnsafe(
      `UPDATE "Assignment" SET "releasedAt" = CURRENT_TIMESTAMP WHERE "itemId" = $1 AND "sessionId" = $2`,
      item.id,
      "session-released",
    );

    const result = (await runtime.call("my_work", { sessionId: "session-released" })) as {
      items: readonly unknown[];
    };
    // Single-character mutation this catches: change `IS NULL` to
    // `IS NOT NULL` (or drop the releasedAt filter clause) in my-work.ts's
    // SQL — the released row would then appear, failing this assertion.
    expect(result.items).toEqual([]);
  });

  it("a session holding SEVERAL items returns all of them, each with its own role", async () => {
    const itemA = await makeItem({ title: "First of several" });
    const itemB = await makeItem({ title: "Second of several" });
    await claim({
      itemId: itemA.id,
      role: "builder",
      holderType: "agent",
      holderId: "crew-member",
      sessionId: "session-multi-item",
      machine: "laptop",
    });
    await claim({
      itemId: itemB.id,
      role: "reviewer",
      holderType: "agent",
      holderId: "crew-member",
      sessionId: "session-multi-item",
      machine: "laptop",
    });

    const result = (await runtime.call("my_work", { sessionId: "session-multi-item" })) as {
      items: readonly { item: { id: string }; assignment: { role: string } }[];
    };
    const byItemId = new Map(result.items.map((entry) => [entry.item.id, entry.assignment.role]));
    expect(result.items).toHaveLength(2);
    expect(byItemId.get(itemA.id)).toBe("builder");
    expect(byItemId.get(itemB.id)).toBe("reviewer");
  });
});
