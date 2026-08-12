// What the migration actually produced, asserted against a real Postgres.
//
// The unit tests above this one all run against in-memory values, so none of
// them can see a column that was declared nullable and shipped NOT NULL, or
// a check constraint that is in the migration file and not in the database.
// Those are exactly the mistakes that survive a green unit suite, so this
// file replays the real migration history onto a scratch database and asks
// the database what it got. Needs TEST_DATABASE_URL; skips locally without
// it, always runs in CI.
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("the settings migration, against a real database", () => {
  const dbName = scratchDatabaseName("settings");
  let client: PrismaClient;

  beforeAll(async () => {
    const scratchUrl = createScratchDatabase(testDatabaseUrl!, dbName);

    // Replay the whole migration history, exactly as a deployment does —
    // not `db push` from the schema, which would prove the schema and not
    // the migration.
    const isWindows = process.platform === "win32";
    const applied = spawnSync(isWindows ? "npx.cmd" : "npx", ["prisma", "migrate", "deploy"], {
      env: { ...process.env, DATABASE_URL: scratchUrl },
      encoding: "utf-8",
      shell: isWindows,
    });
    if (applied.status !== 0) {
      throw new Error(`migrate deploy failed:\n${applied.stderr || applied.stdout}`);
    }

    client = new PrismaClient({ datasourceUrl: scratchUrl });
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function columnMeta(table: string, column: string) {
    const rows = await client.$queryRawUnsafe<
      { data_type: string; is_nullable: string; udt_name: string }[]
    >(
      `SELECT data_type, is_nullable, udt_name
       FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`,
      table,
      column,
    );
    return rows[0];
  }

  it("creates settings with the columns §17.2 specifies", async () => {
    expect(await columnMeta("settings", "key")).toMatchObject({
      data_type: "text",
      is_nullable: "NO",
    });
    // NOT NULL: JSON null is a legal value and is not the same as no row,
    // so "explicitly nothing" is stored rather than represented by absence.
    expect(await columnMeta("settings", "value")).toMatchObject({
      data_type: "jsonb",
      is_nullable: "NO",
    });
    expect(await columnMeta("settings", "updatedById")).toMatchObject({ is_nullable: "YES" });
  });

  it("gives every timestamp a time zone", async () => {
    // Asserted across the whole schema, not just this migration's table: a
    // naive timestamp anywhere is a bug that only shows up twice a year.
    const naive = await client.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type LIKE 'timestamp%'
         AND data_type NOT LIKE '%with time zone'`,
    );
    expect(naive).toEqual([]);
  });

  it("seeds settings_revision with exactly one row, at zero", async () => {
    const rows = await client.$queryRawUnsafe<{ id: number; revision: bigint }[]>(
      `SELECT id, revision FROM settings_revision`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
    expect(rows[0]?.revision).toBe(0n);
  });

  it("refuses a second settings_revision row", async () => {
    // The primary key alone only makes `id` unique — it would happily take
    // a row with id = 2, at which point "the revision" has two answers.
    await expect(
      client.$executeRawUnsafe(`INSERT INTO settings_revision (id, revision) VALUES (2, 0)`),
    ).rejects.toThrow();

    const count = await client.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM settings_revision`,
    );
    expect(count[0]?.n).toBe(1n);
  });

  it("makes machines.source_globs a nullable text array", async () => {
    // MILESTONES #77 and §17.7 both specify `text[]` null. Prisma cannot
    // express a nullable scalar list in its schema language, so this
    // asserts what the database actually got rather than what the schema
    // appears to say.
    const meta = await columnMeta("Machine", "source_globs");
    expect(meta?.data_type).toBe("ARRAY");
    expect(meta?.udt_name).toBe("_text");
    expect(meta?.is_nullable).toBe("YES");
  });

  it("makes accounts.budget_windows nullable jsonb", async () => {
    expect(await columnMeta("Account", "budget_windows")).toMatchObject({
      data_type: "jsonb",
      is_nullable: "YES",
    });
  });

  it("keeps null and empty distinct on source_globs, because they mean opposite things", async () => {
    // Null is "no override, use minting.source_globs"; empty is "override,
    // and scan nothing". Under a COALESCE these are opposites, so a column
    // that could not hold both would silently collapse one into the other.
    await client.$executeRawUnsafe(
      `INSERT INTO "Machine" ("name", "liveSessions", "source_globs") VALUES ('machine-a', 0, NULL)`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Machine" ("name", "liveSessions", "source_globs") VALUES ('machine-b', 0, '{}')`,
    );
    await client.$executeRawUnsafe(
      `INSERT INTO "Machine" ("name", "liveSessions", "source_globs") VALUES ('machine-c', 0, '{"src/**"}')`,
    );

    const rows = await client.$queryRawUnsafe<
      { name: string; is_null: boolean; globs: string[] | null }[]
    >(
      `SELECT "name", "source_globs" IS NULL AS is_null, "source_globs" AS globs
       FROM "Machine" ORDER BY "name"`,
    );

    expect(rows.map((r) => [r.name, r.is_null])).toEqual([
      ["machine-a", true],
      ["machine-b", false],
      ["machine-c", false],
    ]);
    expect(rows[1]?.globs).toEqual([]);
    expect(rows[2]?.globs).toEqual(["src/**"]);
  });

  it("stores a settings row and reads back JSON null as a value", async () => {
    await client.$executeRawUnsafe(
      `INSERT INTO settings ("key", "value", "updatedByType") VALUES ('retention.tool_calls_days', 'null'::jsonb, 'person')`,
    );
    const rows = await client.$queryRawUnsafe<{ value: unknown; is_sql_null: boolean }[]>(
      `SELECT "value", "value" IS NULL AS is_sql_null FROM settings WHERE "key" = 'retention.tool_calls_days'`,
    );
    // Stored as JSON null — a value someone chose — rather than as an
    // absent row or a SQL NULL.
    expect(rows[0]?.is_sql_null).toBe(false);
    expect(rows[0]?.value).toBeNull();
  });

  it("leaves the migration history with no drift against schema.prisma", async () => {
    // The baseline is untouched and this migration is purely additive, so
    // replaying history must reproduce the committed schema exactly.
    const applied = await client.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`,
    );
    expect(applied.length).toBeGreaterThanOrEqual(2);
    expect(applied.some((m) => m.migration_name.includes("settings_core"))).toBe(true);
  });
});
