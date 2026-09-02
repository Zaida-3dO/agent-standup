// Defaults a session declares once and later calls inherit — MILESTONES.md
// #111, SCHEMA.md §21, §1.2.
//
// The claim is that a session which said "I act for this person, and my work
// is supervised" at registration does not have to say it again on every
// create. The tests that matter most here are the ones about what is *not*
// inherited: an explicit value must beat a declaration, a session that
// declared nothing must be left exactly where it was, and no inference may
// run in the direction that would relabel somebody's work as machine-made.
//
// The pure resolution is tested without a database, because its rules are
// pure and a rule that only ever runs behind a `create_task` is a rule whose
// edges are hard to reach. The database half then proves the same rules
// actually apply on the real creation path — including through
// `resolveInboxProject`, which writes an item of its own before `insertItem`
// is ever reached and would otherwise inherit nothing.
//
// Skips the DB half without TEST_DATABASE_URL, like every other DB-backed
// file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { applySessionDeclaration } from "@/lib/service/items/session-defaults";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describe("applySessionDeclaration — what a session's declaration answers", () => {
  const personDriven = { personId: "person-a", driveMode: "supervised" as const };

  // Fails if the `input.driveMode === undefined` test is inverted or dropped
  // — an explicit value would then be overwritten by the declaration.
  it("never overrides a value the caller stated", () => {
    const resolved = applySessionDeclaration(
      { originType: "auto", driveMode: "manual" },
      personDriven,
    );
    expect(resolved.driveMode).toBeUndefined();
    expect(resolved.originType).toBeUndefined();
  });

  // Fails if the `declaration === null` early return is removed.
  it("resolves nothing when there is no session", () => {
    expect(applySessionDeclaration({}, null)).toEqual({});
  });

  // The distinction `Session.driveMode` is nullable for. Fails if a null
  // declaration is treated as `autonomous` — "declared nothing" and
  // "declared the default" would become indistinguishable.
  it("resolves nothing from a session that declared nothing", () => {
    expect(applySessionDeclaration({}, { personId: null, driveMode: null })).toEqual({});
  });

  it("supplies driveMode when the session declared one and the call did not", () => {
    const resolved = applySessionDeclaration({ originType: "auto" }, personDriven);
    expect(resolved.driveMode).toBe("supervised");
  });

  // The one inference, in the one direction that is sound. Fails if the
  // `input.originType === undefined` branch stops setting `originType`.
  it("infers a person origin from a declared person", () => {
    const resolved = applySessionDeclaration({}, personDriven);
    expect(resolved.originType).toBe("person");
    expect(resolved.originPersonId).toBe("person-a");
  });

  // The shape that actually removes a field from the common call: the
  // caller states the origin kind and lets the session say who.
  it("supplies the person when the call names a person origin and nobody else", () => {
    const resolved = applySessionDeclaration({ originType: "person" }, personDriven);
    expect(resolved.originPersonId).toBe("person-a");
  });

  // The inference that must NOT happen. Fails if an `else` branch is added
  // defaulting `originType` to `auto` for a session with no declared person
  // — work created on somebody's behalf from an autonomous session would be
  // silently relabelled as machine-originated.
  it("does not infer an origin for a session that declared no person", () => {
    const resolved = applySessionDeclaration({}, { personId: null, driveMode: "autonomous" });
    expect(resolved.originType).toBeUndefined();
    expect(resolved.driveMode).toBe("autonomous");
  });

  // Fails if the person is supplied regardless of the effective origin — a
  // `source`-origin item would acquire an `originPersonId`, which SCHEMA.md
  // §1 ties specifically to a person origin.
  it("does not attach a person to a source origin", () => {
    const resolved = applySessionDeclaration({ originType: "source" }, personDriven);
    expect(resolved.originPersonId).toBeUndefined();
  });
});

describeIfDb("session-declared defaults on the real creation path", () => {
  const dbName = scratchDatabaseName("session_defaults");
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
    await prisma.person.create({ data: { id: "person-a", displayName: "A person" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  interface Created {
    id: string;
    originType: string;
    originPersonId: string | null;
    driveMode: string;
  }

  interface Rejection {
    code: string;
    fields?: string[];
    message: string;
  }

  /** Registers a session through the operation itself, so the stored row is the one a real client produces. */
  async function register(
    sessionId: string,
    declaration: { personId?: string; driveMode?: string },
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (runtime.call as any)(
      "register_session",
      { sessionId, machine: "test-machine", ...declaration },
      { caller: { transport: "http" } },
    );
  }

  async function callAs<T>(
    sessionId: string | undefined,
    name: string,
    input: unknown,
  ): Promise<T> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await (runtime.call as any)(name, input, {
      caller: sessionId === undefined ? {} : { sessionId },
    })) as T;
  }

  async function rejectionAs(
    sessionId: string | undefined,
    name: string,
    input: unknown,
  ): Promise<Rejection> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const error = await (runtime.call as any)(name, input, {
      caller: sessionId === undefined ? {} : { sessionId },
    }).catch((e: unknown) => e);
    return error as Rejection;
  }

  function base(title: string, area = "defaults") {
    return { title, body: "The brief.", area };
  }

  // The whole point of the row: a create that names neither field.
  it("lets a declared session create without restating origin or drive mode", async () => {
    await register("session-declared", { personId: "person-a", driveMode: "supervised" });

    const project = await callAs<Created>(
      "session-declared",
      "create_project",
      base("Inherited project"),
    );

    expect(project.originType).toBe("person");
    expect(project.originPersonId).toBe("person-a");
    expect(project.driveMode).toBe("supervised");
  });

  // Fails if `insertItem` stops spreading the resolution over its input —
  // the explicit value would be lost rather than merely un-inherited.
  it("honours an explicit value over the declaration", async () => {
    await register("session-explicit", { personId: "person-a", driveMode: "supervised" });

    const project = await callAs<Created>("session-explicit", "create_project", {
      ...base("Explicit project"),
      originType: "auto",
      driveMode: "manual",
    });

    expect(project.originType).toBe("auto");
    expect(project.originPersonId).toBeNull();
    expect(project.driveMode).toBe("manual");
  });

  // Every creation path has to inherit, or the four operations disagree.
  it("inherits on create_task and create_subtask too", async () => {
    await register("session-tree", { personId: "person-a", driveMode: "supervised" });

    const project = await callAs<Created>("session-tree", "create_project", base("Tree root"));
    const task = await callAs<Created>("session-tree", "create_task", {
      ...base("Tree task"),
      projectId: project.id,
    });
    const subtask = await callAs<Created>("session-tree", "create_subtask", {
      ...base("Tree subtask"),
      taskId: task.id,
    });

    for (const item of [task, subtask]) {
      expect(item.originType).toBe("person");
      expect(item.originPersonId).toBe("person-a");
      expect(item.driveMode).toBe("supervised");
    }
  });

  // `resolveInboxProject` writes an item *before* `insertItem` runs, so it
  // resolves the declaration separately. Fails if that second resolution is
  // removed: the inbox project would be attributed `auto` while the task
  // filed into it is attributed to a person.
  it("attributes an auto-minted inbox project the same way as the task filed into it", async () => {
    await register("session-inbox", { personId: "person-a", driveMode: "supervised" });

    const task = await callAs<Created>("session-inbox", "create_task", {
      ...base("Quick capture", "inbox-area"),
      projectId: "inbox",
    });

    const inboxRows = await prisma.$queryRawUnsafe<
      { originType: string; originPersonId: string | null }[]
    >(
      `SELECT i."originType", i."originPersonId" FROM "Item" i
       WHERE i."id" = (SELECT "parentId" FROM "Item" WHERE "id" = $1)`,
      task.id,
    );
    expect(inboxRows[0]?.originType).toBe("person");
    expect(inboxRows[0]?.originPersonId).toBe("person-a");
  });

  // The behaviour for everyone who has not declared anything must be exactly
  // what it was. Fails if `originType` stops being required once it became
  // optional in the schema — the refusal is the only thing keeping it so.
  it("still requires originType from a session that declared nothing", async () => {
    await register("session-bare", {});

    const rejection = await rejectionAs("session-bare", "create_project", base("Bare project"));
    expect(rejection.code).toBe("invalid_input");
    expect(rejection.fields).toContain("originType");
  });

  // Same, for a caller with no session at all — a script, a test, an
  // in-process call.
  it("still requires originType when there is no session", async () => {
    const rejection = await rejectionAs(undefined, "create_project", base("Sessionless"));
    expect(rejection.code).toBe("invalid_input");
    expect(rejection.fields).toContain("originType");
  });

  // Fails if `driveMode` is given a schema `.default("autonomous")` again:
  // the default would resolve before the declaration and silently outrank a
  // session that declared `supervised`.
  it("falls back to autonomous only when neither the call nor the session says", async () => {
    await register("session-drive-only", { driveMode: undefined });

    const project = await callAs<Created>("session-drive-only", "create_project", {
      ...base("No drive mode anywhere"),
      originType: "auto",
    });
    expect(project.driveMode).toBe("autonomous");
  });

  // A person origin with no person is the state `originPersonCheck` exists
  // to make unrepresentable, and the parse-time refinement cannot see the
  // declaration. Fails if the post-resolution re-check in `insertItem` is
  // removed.
  it("refuses a person origin when the session declared no person to inherit", async () => {
    await register("session-no-person", { driveMode: "supervised" });

    const rejection = await rejectionAs("session-no-person", "create_project", {
      ...base("Person origin, nobody named"),
      originType: "person",
    });
    expect(rejection.code).toBe("invalid_input");
    expect(rejection.fields).toContain("originPersonId");
  });

  // Fails if the upsert's COALESCE is changed back to a plain
  // `EXCLUDED` overwrite — an ordinary re-registration sends neither field
  // and would silently un-declare the session mid-run.
  it("keeps a declaration through a re-registration that does not restate it", async () => {
    await register("session-refresh", { personId: "person-a", driveMode: "supervised" });
    await register("session-refresh", {});

    const project = await callAs<Created>(
      "session-refresh",
      "create_project",
      base("After a refresh"),
    );
    expect(project.originType).toBe("person");
    expect(project.originPersonId).toBe("person-a");
    expect(project.driveMode).toBe("supervised");
  });

  // A person row cannot simply vanish from under a declaration — the
  // foreign key nulls `Session.personId` if the person is deleted — so the
  // reachable stale case is a session whose declaration was never valid to
  // begin with. The point being pinned is that the inherited person goes
  // through `insertItem`'s existence check exactly as a typed one does, so
  // a declaration can never write a dangling reference on the strength of
  // having been declared rather than typed.
  //
  // Fails if that lookup is narrowed to run only for a caller-supplied
  // person — the row would be inserted pointing at nobody.
  it("validates an inherited person against the database, not just against the declaration", async () => {
    await prisma.session.create({
      data: { id: "session-stale", machine: "test-machine", transport: "http" },
    });
    // Written directly rather than through `register_session`, because the
    // operation would refuse a person that does not exist — which is the
    // check under test one level up. This produces the row a database
    // edited outside the product would leave behind.
    await prisma.$executeRawUnsafe(
      `UPDATE "Session" SET "personId" = NULL WHERE "id" = $1`,
      "session-stale",
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Session" DROP CONSTRAINT IF EXISTS "Session_personId_fkey"`,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "Session" SET "personId" = 'person-gone' WHERE "id" = $1`,
      "session-stale",
    );

    const rejection = await rejectionAs("session-stale", "create_project", base("Stale person"));
    expect(rejection.code).toBe("not_found");
    expect(rejection.fields).toContain("originPersonId");
  });
});
