// The capabilities `update_person` exists to unblock — MILESTONES.md #116.
//
// `tests/update-person-operation.test.ts` proves the operation itself. This
// file proves the *reason for it*, and is deliberately separate: a green
// suite on the operation would not have told anyone whether the three dead
// capabilities came back to life, and those are the deliverable. Each test
// below fails against `main` for the same single reason — there is no way
// to mint a person — so together they are the regression net for the gap
// rather than for the code that closed it.
//
//   1. The profile picker (§8a) reads `list_people`; a written person must
//      appear in it.
//   2. `merge.requires_authorisation` needs a *person* recorded as
//      `createdByType: "person"` on an approving `code_review` artifact.
//   3. `create_item` verifies `originPersonId` exists — provenance.
//
// Placeholder identities only (`user-a`, `reviewer-b`) — public repository.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { PersonAdminRecord } from "@/lib/service/admin/person-row";
import type { ListPeopleOutput } from "@/lib/service/operations/list-people";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("what the people write path unblocks", () => {
  const dbName = scratchDatabaseName("person_unblocks");
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
    await prisma.area.create({ data: { id: "provenance", displayName: "provenance" } });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  // ── 1. The profile picker ─────────────────────────────────────────────

  it("a written person is readable through list_people — the picker's whole data source", async () => {
    await runtime.call("update_person", {
      id: "user-a",
      displayName: "User A",
      avatar: "🙂",
      colour: "#336699",
    });

    const output = (await runtime.call("list_people", {})) as ListPeopleOutput;
    expect(output.people).toContainEqual({
      id: "user-a",
      displayName: "User A",
      avatar: "🙂",
      colour: "#336699",
      archivedAt: null,
    });
  });

  // ── 2. Provenance: originType "person" ────────────────────────────────

  it("MINTS AN ITEM WITH originType 'person' and a real person id — the provenance path", async () => {
    // The urgent one. `create_item`'s schema has always accepted
    // `originPersonId`, and its handler has always verified the person
    // exists — which made the branch unsatisfiable with no writer, so every
    // item had to claim `source` or `auto` origin even when a human asked.
    const person = (await runtime.call("update_person", {
      id: "user-requester",
      displayName: "Requester",
    })) as PersonAdminRecord;

    const item = (await runtime.call("create_item", {
      title: "Something a human actually asked for",
      body: "x",
      area: "provenance",
      originType: "person",
      originPersonId: person.id,
    })) as { id: string };

    // Read the stored columns, not the return value: provenance is only
    // real if it is on the row.
    const rows = await prisma.$queryRawUnsafe<
      { originType: string; originPersonId: string | null }[]
    >(
      `SELECT "originType"::text AS "originType", "originPersonId" FROM "Item" WHERE "id" = $1`,
      item.id,
    );
    expect(rows[0]!.originType).toBe("person");
    expect(rows[0]!.originPersonId).toBe("user-requester");
  });

  it("still refuses originType 'person' with an id that names nobody", async () => {
    // The counterpart: the write path must not have weakened the check that
    // makes provenance meaningful. If this passed, `originPersonId` would be
    // a free-text field rather than a reference.
    await expect(
      runtime.call("create_item", {
        title: "x",
        body: "x",
        area: "provenance",
        originType: "person",
        originPersonId: "user-who-does-not-exist",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  // ── 3. merge.requires_authorisation: a person's approving review ──────

  it("records a person as createdByType 'person' on an approving code_review artifact", async () => {
    // What `merge.requires_authorisation` needs to be satisfiable: a
    // *person* — not an agent — recorded as the creator of an approving
    // review. With no writer there was no person id to name here, so no
    // `needs_approval` item could reach `merged`.
    const reviewer = (await runtime.call("update_person", {
      id: "reviewer-b",
      displayName: "Reviewer B",
    })) as PersonAdminRecord;

    const item = (await runtime.call("create_item", {
      title: "Needs a human sign-off",
      body: "x",
      area: "provenance",
      originType: "person",
      originPersonId: reviewer.id,
    })) as { id: string };

    const artifact = (await runtime.call("record_artifact", {
      itemId: item.id,
      kind: "code_review",
      verdict: "lgtm",
      createdByType: "person",
      createdById: reviewer.id,
    })) as { id: string; createdByType: string; createdById: string };

    expect(artifact.createdByType).toBe("person");
    expect(artifact.createdById).toBe("reviewer-b");

    const rows = await prisma.$queryRawUnsafe<
      { createdByType: string; createdById: string; verdict: string | null }[]
    >(
      `SELECT "createdByType"::text AS "createdByType", "createdById", "verdict"::text AS "verdict"
         FROM "Artifact" WHERE "id" = $1`,
      artifact.id,
    );
    expect(rows[0]!.createdByType).toBe("person");
    expect(rows[0]!.createdById).toBe("reviewer-b");
    expect(rows[0]!.verdict).toBe("lgtm");
  });

  // ── The MCP surface ───────────────────────────────────────────────────

  it("exposes update_person as an MCP tool — tools are registry-derived, so this is a check not an assumption", async () => {
    const { toolsFromOperations } = await import("@/lib/mcp/tools");
    const { listOperations } = await import("@/lib/service");
    const tools = toolsFromOperations(listOperations());
    const tool = tools.find((entry) => entry.name === "update_person");
    expect(tool).toBeDefined();
    expect(tool!.description).toContain("profile");
  });
});
