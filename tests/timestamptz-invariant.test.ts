// A timezone-naive timestamp is silent, data-corrupting, and brutal to
// retrofit once real rows depend on it — the write succeeds, the value
// looks plausible, and every reader has to guess which offset it was
// written in. Postgres has a type built for exactly this: `timestamptz`
// stores an absolute instant, so it survives readers and writers in
// different zones without anyone having to agree on a convention.
//
// Both halves of this file check the same invariant from two different
// artifacts — the schema Prisma generates from, and the migration SQL that
// actually shipped to the database — because either one drifting on its own
// is the failure this exists to catch. A schema fixed after the fact with no
// new migration passes the first check and fails the second; a migration
// hand-edited after `prisma migrate dev` generated it passes the second and
// fails the first.
import { readFileSync } from "node:fs";
import path from "node:path";
import { glob } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const schemaPath = path.resolve(import.meta.dirname, "../prisma/schema.prisma");

// Matches a field declaration line: leading whitespace, a field name, then
// the `DateTime` type, then either the end of the line or whitespace before
// any attributes. The trailing `(\s|$)` is deliberate — a field with no
// `@db.Timestamptz(` attribute (the exact case this test exists to catch)
// has nothing after `DateTime?`, so anchoring on trailing whitespace alone
// would silently skip it.
const FIELD_LINE = /^\s*\S+\s+DateTime\??(\s|$)/;

function dateTimeFieldLines(schema: string): string[] {
  return schema.split("\n").filter((line) => FIELD_LINE.test(line));
}

describe("every DateTime field in the schema is timezone-aware", () => {
  it("carries @db.Timestamptz( on every DateTime field", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const fields = dateTimeFieldLines(schema);

    // If this is empty, the pattern above stopped matching the schema's
    // shape — not that the schema has no DateTime fields, which would make
    // the rest of this test vacuously green.
    expect(fields.length).toBeGreaterThan(0);

    const bare = fields.filter((line) => !line.includes("@db.Timestamptz("));

    expect(bare).toEqual([]);
  });
});

describe("every applied migration only ever emits a timezone-aware timestamp column", () => {
  it("never emits a bare TIMESTAMP( column", async () => {
    const migrationsRoot = path.resolve(import.meta.dirname, "../prisma/migrations");
    const violations: string[] = [];

    for await (const file of glob("**/migration.sql", { cwd: migrationsRoot })) {
      const sql = readFileSync(path.join(migrationsRoot, file), "utf8");

      sql.split("\n").forEach((line, index) => {
        // `\b` does not fall between `TIMESTAMP` and `TZ` — both are word
        // characters — so this matches a bare `TIMESTAMP(` column type
        // without also matching `TIMESTAMPTZ(`.
        if (/\bTIMESTAMP\(/i.test(line)) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
