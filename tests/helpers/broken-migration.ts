// A throwaway schema + a single migration that always fails when applied —
// used to force a *real* `prisma migrate deploy` failure (Prisma's own
// P3018 "a migration failed to apply") without touching this repo's own
// `prisma/schema.prisma` or `prisma/migrations` (out of territory for this
// PR). The failure is self-contained (a `RAISE EXCEPTION`, not a collision
// with some incidental existing state), so it fails identically every time.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BROKEN_MIGRATION_SQL = `DO $$
BEGIN
  RAISE EXCEPTION 'deliberately broken migration — used only by tests to prove a real "prisma migrate deploy" failure is handled correctly';
END $$;
`;

export function createBrokenMigrationSchema(): { schemaPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-standup-broken-migration-"));
  const schemaPath = path.join(dir, "schema.prisma");
  writeFileSync(
    schemaPath,
    'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
  );

  const migrationDir = path.join(dir, "migrations", "00000000000000_broken");
  mkdirSync(migrationDir, { recursive: true });
  writeFileSync(path.join(migrationDir, "migration.sql"), BROKEN_MIGRATION_SQL);

  return {
    schemaPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
