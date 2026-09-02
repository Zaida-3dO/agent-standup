// `list_people` against a real Postgres — SCHEMA.md §19 (`GET /people`),
// §8a ("Netflix-style profile picker … archive rather than delete").
// Same shape as tests/board-operations.test.ts: a real database is needed
// because the interesting behaviour (excluding an archived row) is a WHERE
// clause a mocked driver can't prove.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { ListPeopleOutput } from "@/lib/service/operations/list-people";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("list_people against Postgres", () => {
  const dbName = scratchDatabaseName("list_people_ops");
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

  async function insertPerson(overrides: {
    id: string;
    displayName: string;
    avatar?: string | null;
    colour?: string | null;
    archivedAt?: Date | null;
    createdAt?: Date;
  }): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Person" ("id", "displayName", "avatar", "colour", "createdAt", "archivedAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      overrides.id,
      overrides.displayName,
      overrides.avatar ?? null,
      overrides.colour ?? null,
      overrides.createdAt ?? new Date(),
      overrides.archivedAt ?? null,
    );
  }

  it("returns an empty list against a scratch database with no people", async () => {
    // A fresh scratch database, migrated but never seeded — proves the
    // operation doesn't assume the two seeded rows exist.
    const output = (await runtime.call("list_people", {})) as ListPeopleOutput;
    expect(output.people).toEqual([]);
  });

  it("returns a created, non-archived person with the fields the picker needs", async () => {
    await insertPerson({
      id: "list-people-a",
      displayName: "Person A",
      avatar: "🙂",
      colour: "#ff0000",
    });

    const output = (await runtime.call("list_people", {})) as ListPeopleOutput;
    const found = output.people.find((p) => p.id === "list-people-a");
    // T13: `archivedAt` joined the shape (always present, null when
    // active) so the admin grid can render the same record the picker
    // reads — see list-people.ts's header.
    expect(found).toEqual({
      id: "list-people-a",
      displayName: "Person A",
      avatar: "🙂",
      colour: "#ff0000",
      archivedAt: null,
    });
  });

  it("returns null avatar/colour as null, not undefined or a placeholder string", async () => {
    await insertPerson({ id: "list-people-nulls", displayName: "No Avatar" });

    const output = (await runtime.call("list_people", {})) as ListPeopleOutput;
    const found = output.people.find((p) => p.id === "list-people-nulls");
    expect(found?.avatar).toBeNull();
    expect(found?.colour).toBeNull();
  });

  it("EXCLUDES an archived person — the exact behaviour §8a's 'archive rather than delete' depends on", async () => {
    await insertPerson({ id: "list-people-live", displayName: "Still Around" });
    await insertPerson({
      id: "list-people-archived",
      displayName: "Archived",
      archivedAt: new Date(),
    });

    const output = (await runtime.call("list_people", {})) as ListPeopleOutput;
    const ids = output.people.map((p) => p.id);
    expect(ids).toContain("list-people-live");
    expect(ids).not.toContain("list-people-archived");
  });

  it("includes an archived person when includeArchived is true, with archivedAt set", async () => {
    await insertPerson({ id: "list-people-visible", displayName: "Still Around" });
    await insertPerson({
      id: "list-people-archived-visible",
      displayName: "Archived",
      archivedAt: new Date("2024-05-01T00:00:00Z"),
    });

    const output = (await runtime.call("list_people", {
      includeArchived: true,
    })) as ListPeopleOutput;
    const found = output.people.find((p) => p.id === "list-people-archived-visible");
    expect(found).toBeDefined();
    expect(found?.archivedAt).toBe("2024-05-01T00:00:00.000Z");
    // The active one is still there too — includeArchived widens, it does
    // not replace, the default set.
    expect(output.people.map((p) => p.id)).toContain("list-people-visible");
  });

  it("defaults includeArchived to false when omitted, matching list_repos's own default", async () => {
    await insertPerson({
      id: "list-people-default-archived",
      displayName: "Archived By Default",
      archivedAt: new Date(),
    });

    const output = (await runtime.call("list_people", {})) as ListPeopleOutput;
    expect(output.people.map((p) => p.id)).not.toContain("list-people-default-archived");
  });

  it("orders people by createdAt ascending, not insertion order or id order", async () => {
    // Inserted in reverse createdAt order and in reverse id order too, so a
    // mutant that dropped the ORDER BY (falling back to Postgres's
    // insertion-adjacent default) or swapped ASC for DESC would show up as
    // a wrong sequence here, not merely a wrong set.
    const earlier = new Date("2020-01-01T00:00:00Z");
    const later = new Date("2020-01-02T00:00:00Z");
    await insertPerson({ id: "list-people-order-z", displayName: "Z", createdAt: later });
    await insertPerson({ id: "list-people-order-a", displayName: "A", createdAt: earlier });

    const output = (await runtime.call("list_people", {})) as ListPeopleOutput;
    const ids = output.people.map((p) => p.id);
    const zIndex = ids.indexOf("list-people-order-z");
    const aIndex = ids.indexOf("list-people-order-a");
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(zIndex).toBeGreaterThanOrEqual(0);
    expect(aIndex).toBeLessThan(zIndex);
  });

  it("rejects an unexpected input field — the schema is strict, like every other no-input read", async () => {
    await expect(runtime.call("list_people", { bogus: true })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});
