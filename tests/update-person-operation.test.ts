// `update_person` against a real Postgres — SCHEMA.md §19 `/people`, §8a
// ("archive rather than delete"), §1.1b (`notify_rules`). MILESTONES.md #116.
//
// A real database is needed rather than a mocked driver because most of
// what is interesting here is SQL: the `ON CONFLICT` upsert, the CASE
// guards that keep an unmentioned column from being clobbered, the
// `::jsonb` cast, and the NOT NULL column a creation must satisfy. A mock
// would let every one of those be wrong and still pass.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
//
// Placeholder identities throughout (`user-a`, `person-b`) — this is a
// public repository and fixtures must not carry real names.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { parseStoredRules, loadPersonRules } from "@/lib/service/notify-on-change";
import type { PersonAdminRecord } from "@/lib/service/admin/person-row";
import type { ListPeopleOutput } from "@/lib/service/operations/list-people";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("update_person against Postgres", () => {
  const dbName = scratchDatabaseName("update_person_ops");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  const call = (input: unknown) =>
    runtime.call("update_person", input) as Promise<PersonAdminRecord>;

  // ── Creation ──────────────────────────────────────────────────────────

  it("creates a person that did not exist, with the caller's own id", async () => {
    const person = await call({
      id: "user-a",
      displayName: "User A",
      avatar: "🙂",
      colour: "#ff0000",
    });

    expect(person.id).toBe("user-a");
    expect(person.displayName).toBe("User A");
    expect(person.avatar).toBe("🙂");
    expect(person.colour).toBe("#ff0000");
    expect(person.archivedAt).toBeNull();
    expect(person.createdAt).toEqual(expect.any(String));

    // Read back from the database rather than trusting the RETURNING clause
    // — proves the row is actually there, not merely echoed.
    const rows = await prisma.$queryRawUnsafe<{ id: string; displayName: string }[]>(
      `SELECT "id", "displayName" FROM "Person" WHERE "id" = $1`,
      "user-a",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.displayName).toBe("User A");
  });

  it("creates with optional fields absent, storing NULL rather than a placeholder", async () => {
    const person = await call({ id: "user-minimal", displayName: "Minimal" });
    expect(person.avatar).toBeNull();
    expect(person.colour).toBeNull();
    expect(person.notifyRules).toBeNull();
  });

  it("REFUSES to create without displayName — the NOT NULL column, named as a field error", async () => {
    // Not a Postgres constraint violation leaking out as an internal error:
    // the caller gets `invalid_input` naming `displayName`. A mutant that
    // dropped the existence pre-check would surface a different code here.
    await expect(call({ id: "user-no-name", colour: "#123456" })).rejects.toMatchObject({
      code: "invalid_input",
      fields: ["displayName"],
    });

    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Person" WHERE "id" = $1`,
      "user-no-name",
    );
    expect(rows).toHaveLength(0);
  });

  // ── Update ────────────────────────────────────────────────────────────

  it("updates an existing person WITHOUT requiring displayName to be restated", async () => {
    await call({ id: "user-b", displayName: "User B", colour: "#000000" });
    const updated = await call({ id: "user-b", colour: "#00ff00" });

    // The whole point of the create/edit asymmetry: an edit touching only
    // colour keeps the name it never mentioned.
    expect(updated.displayName).toBe("User B");
    expect(updated.colour).toBe("#00ff00");
  });

  it("does NOT clobber unmentioned fields — the CASE guards, one field at a time", async () => {
    await call({
      id: "user-c",
      displayName: "User C",
      avatar: "🐈",
      colour: "#abcdef",
      notifyRules: [{ notify: ["user-c"], when_all: [{ field: "state", op: "changed" }] }],
    });

    // Touch displayName only. Every other column must survive untouched —
    // this is the assertion that dies if `CASE WHEN $n THEN … ELSE col END`
    // is replaced by a bare `EXCLUDED.col` assignment.
    const updated = await call({ id: "user-c", displayName: "User C Renamed" });
    expect(updated.displayName).toBe("User C Renamed");
    expect(updated.avatar).toBe("🐈");
    expect(updated.colour).toBe("#abcdef");
    expect(updated.notifyRules).not.toBeNull();
    expect(parseStoredRules(updated.notifyRules)).toHaveLength(1);
  });

  it("clears avatar and colour when passed an explicit null, distinct from omitting them", async () => {
    await call({ id: "user-d", displayName: "User D", avatar: "🦊", colour: "#111111" });

    const cleared = await call({ id: "user-d", avatar: null, colour: null });
    expect(cleared.avatar).toBeNull();
    expect(cleared.colour).toBeNull();
    // And the name, which was omitted, is still there — omission and
    // explicit null are genuinely different inputs.
    expect(cleared.displayName).toBe("User D");
  });

  it("does not create a duplicate row on a second call with the same id", async () => {
    await call({ id: "user-once", displayName: "First" });
    await call({ id: "user-once", displayName: "Second" });

    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Person" WHERE "id" = $1`,
      "user-once",
    );
    expect(rows).toHaveLength(1);
  });

  it("preserves createdAt across an update — an upsert must not look like a re-creation", async () => {
    const created = await call({ id: "user-stable", displayName: "Stable" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const updated = await call({ id: "user-stable", displayName: "Stable Renamed" });
    expect(updated.createdAt).toBe(created.createdAt);
  });

  // ── Archive / un-archive ──────────────────────────────────────────────

  it("archives a person, and list_people then EXCLUDES them", async () => {
    await call({ id: "user-arch", displayName: "To Archive" });

    const before = (await runtime.call("list_people", {})) as ListPeopleOutput;
    expect(before.people.map((p) => p.id)).toContain("user-arch");

    const archived = await call({ id: "user-arch", archived: true });
    expect(archived.archivedAt).not.toBeNull();

    const after = (await runtime.call("list_people", {})) as ListPeopleOutput;
    expect(after.people.map((p) => p.id)).not.toContain("user-arch");
  });

  it("un-archives a person, and list_people shows them again", async () => {
    await call({ id: "user-unarch", displayName: "Round Trip" });
    await call({ id: "user-unarch", archived: true });

    const restored = await call({ id: "user-unarch", archived: false });
    expect(restored.archivedAt).toBeNull();

    const after = (await runtime.call("list_people", {})) as ListPeopleOutput;
    expect(after.people.map((p) => p.id)).toContain("user-unarch");
  });

  it("leaves archivedAt alone when `archived` is omitted", async () => {
    await call({ id: "user-keep-arch", displayName: "Keep" });
    const archived = await call({ id: "user-keep-arch", archived: true });

    // An unrelated edit must not silently resurrect an archived profile.
    const edited = await call({ id: "user-keep-arch", colour: "#999999" });
    expect(edited.archivedAt).toBe(archived.archivedAt);
  });

  it("creates a person already archived when created with archived: true", async () => {
    const person = await call({
      id: "user-born-arch",
      displayName: "Born Archived",
      archived: true,
    });
    expect(person.archivedAt).not.toBeNull();
  });

  // ── notifyRules: the casing bridge ────────────────────────────────────

  it("stores notifyRules in the snake_case spelling parseStoredRules can actually read", async () => {
    // The round trip that matters: what is written here must survive the
    // evaluator's own parser. Asserting on `parseStoredRules` rather than on
    // the raw JSON is deliberate — it is the function that decides whether a
    // stored rule ever fires.
    const person = await call({
      id: "user-rules",
      displayName: "Rules",
      notifyRules: [
        {
          notify: ["user-rules"],
          when_all: [{ field: "state", op: "eq", value: "merged" }],
        },
      ],
    });

    const parsed = parseStoredRules(person.notifyRules);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.whenAll).toEqual([{ field: "state", op: "eq", value: "merged" }]);
    expect(parsed[0]!.notify).toEqual(["user-rules"]);
  });

  it("the stored rules are loadable by loadPersonRules — the evaluator's own entry point", async () => {
    await call({
      id: "user-loadable",
      displayName: "Loadable",
      notifyRules: [
        { notify: ["user-loadable"], when_any: [{ field: "priority", op: "changed" }] },
      ],
    });

    const loaded = await prisma.$transaction(async (tx) => loadPersonRules(tx as never));
    const mine = loaded.find((entry) => entry.personId === "user-loadable");
    expect(mine).toBeDefined();
    expect(mine!.rules).toHaveLength(1);
    expect(mine!.rules[0]!.whenAny).toEqual([{ field: "priority", op: "changed" }]);
  });

  it("REFUSES the camelCase whenAll spelling — it would parse to no conditions and fire on nothing", async () => {
    // The most valuable refusal in the file. A rule stored as `whenAll`
    // survives the column and parses to zero conditions — and such a rule
    // fires **zero** times, not constantly. `ruleMatches` does treat a missing
    // bucket as vacuously true, which makes the opposite easy to infer, but
    // `parseStoredRules` drops the rule before the evaluator sees it and
    // `evaluateRules` is edge-triggered, so a rule matching everything matches
    // the `before` snapshot too and never fires. Silence is the worse failure:
    // the rule looks configured and notifies nobody.
    //
    // **Two independent guards reject this input**, and mutation testing
    // proved it: `.strict()` rejects the unknown key, and — because a
    // non-strict Zod object *strips* an unknown key rather than keeping it —
    // the `.refine()` also rejects the result for having no usable bucket.
    // Removing either one alone leaves this input still refused. That is
    // defence in depth rather than redundancy, but it means this test alone
    // does not pin `.strict()`, so the assertion below pins it directly:
    // the error must name `when_all`/`when_any` as unrecognised, which only
    // `.strict()` produces. Deleting `.strict()` fails this test on the
    // message even though the call is still rejected.
    const rejection = await call({
      id: "user-camel",
      displayName: "Camel",
      notifyRules: [{ notify: ["user-camel"], whenAll: [{ field: "state", op: "changed" }] }],
    }).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );

    expect(rejection).not.toBeNull();
    expect(rejection!.code).toBe("invalid_input");
    // `.strict()`'s signature: it names the offending key. The `.refine()`
    // path would instead complain about a missing bucket.
    expect(rejection!.message).toMatch(/whenAll|unrecognized|unrecognised/i);

    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Person" WHERE "id" = $1`,
      "user-camel",
    );
    expect(rows).toHaveLength(0);
  });

  it("REFUSES a rule with no conditions in either bucket — it would notify on everything", async () => {
    await expect(
      call({ id: "user-empty-rule", displayName: "Empty", notifyRules: [{ notify: ["x"] }] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("REFUSES a rule whose only conditions are empty arrays", async () => {
    await expect(
      call({
        id: "user-empty-arrays",
        displayName: "Empty Arrays",
        notifyRules: [{ notify: ["x"], when_all: [], when_any: [] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("REFUSES a condition naming a field outside the notify whitelist", async () => {
    // `parseStoredRules` drops such a condition on read; if that were the
    // rule's only condition it would leave an empty bucket and fire on
    // everything. Refusing on write is what turns that into a visible error.
    await expect(
      call({
        id: "user-bad-field",
        displayName: "Bad Field",
        notifyRules: [{ notify: ["x"], when_all: [{ field: "not_a_field", op: "eq", value: 1 }] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("REFUSES an unknown operator", async () => {
    await expect(
      call({
        id: "user-bad-op",
        displayName: "Bad Op",
        notifyRules: [{ notify: ["x"], when_all: [{ field: "state", op: "matches", value: 1 }] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("REFUSES notifyRules that is not an array", async () => {
    await expect(
      call({ id: "user-not-array", displayName: "Not Array", notifyRules: { notify: ["x"] } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("REFUSES a rule with an empty notify list — a rule that notifies nobody", async () => {
    await expect(
      call({
        id: "user-no-recipients",
        displayName: "No Recipients",
        notifyRules: [{ notify: [], when_all: [{ field: "state", op: "changed" }] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("clears notifyRules with an explicit null, writing a SQL NULL not the JSON scalar null", async () => {
    await call({
      id: "user-clear-rules",
      displayName: "Clear",
      notifyRules: [{ notify: ["x"], when_all: [{ field: "state", op: "changed" }] }],
    });

    const cleared = await call({ id: "user-clear-rules", notifyRules: null });
    expect(cleared.notifyRules).toBeNull();

    // The distinction that matters: `loadPersonRules` filters on
    // `"notifyRules" IS NOT NULL`. A stored JSON scalar null would slip past
    // that filter and be parsed on every mutation. `IS NULL` in SQL is the
    // only assertion that can tell the two apart — `notifyRules` reads back
    // as `null` in JS either way.
    const rows = await prisma.$queryRawUnsafe<{ isNull: boolean }[]>(
      `SELECT ("notifyRules" IS NULL) AS "isNull" FROM "Person" WHERE "id" = $1`,
      "user-clear-rules",
    );
    expect(rows[0]!.isNull).toBe(true);
  });

  // ── Schema strictness ─────────────────────────────────────────────────

  it("REFUSES an unknown input field — the schema is strict, like every sibling admin write", async () => {
    await expect(
      call({ id: "user-bogus", displayName: "Bogus", nickname: "nope" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("REFUSES an empty id and an empty displayName", async () => {
    await expect(call({ id: "", displayName: "X" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(call({ id: "user-blank-name", displayName: "   " })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
