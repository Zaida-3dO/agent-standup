// `list_people` against a real Postgres — SCHEMA.md §19 (`GET /people`),
// §8a ("Netflix-style profile picker … archive rather than delete").
// Same shape as tests/board-operations.test.ts: a real database is needed
// because the interesting behaviour (excluding an archived row) is a WHERE
// clause a mocked driver can't prove.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { ListPeopleOutput } from "@/lib/service/operations/list-people";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("list_people against Postgres", () => {
  const dbName = scratchDatabaseName("list_people_ops");
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
    expect(found).toEqual({
      id: "list-people-a",
      displayName: "Person A",
      avatar: "🙂",
      colour: "#ff0000",
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
