// Guards how DB-backed test files obtain their database.
//
// Preparing a database per test file is dominated by process startup: every
// `prisma` invocation is an `npx` + CLI cold start costing seconds, far more
// than the SQL or the migrations themselves. A file that creates an empty
// database and then applies every committed migration to it pays that toll
// several times over, and because the toll is per FILE rather than per test, a
// suite of such files spends most of its wall-clock before asserting anything.
//
// `createMigratedScratchDatabase` avoids it by cloning a template built once
// for the whole run (tests/helpers/global-setup.ts). This test exists so a new
// DB-backed file cannot quietly reintroduce the slow shape — the cost would not
// show up as a failure, only as a suite that gradually gets slower, which is
// exactly the kind of regression nobody attributes to the commit that caused it.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TESTS_DIR = path.resolve(import.meta.dirname);

/**
 * Files that legitimately want an EMPTY database and migrate it themselves (or
 * assert on migration/pool/boot behaviour), so cloning a pre-migrated template
 * would defeat the point of the test.
 *
 * Adding a name here is a deliberate act: it says "this file tests the
 * migration or connection machinery itself", not "this file is in a hurry".
 */
const MAY_MIGRATE_THEMSELVES = new Set([
  "boot.test.ts",
  "db-pool.test.ts",
  "entrypoint.test.ts",
  "partial-index-drift.test.ts",
  "settings-migration.test.ts",
]);

/** This file's own name — it names both helpers as search strings, not as calls. */
const SELF = path.basename(import.meta.filename);

function testFiles(): string[] {
  return readdirSync(TESTS_DIR).filter((name) => name.endsWith(".test.ts") && name !== SELF);
}

describe("DB-backed test files use the shared migrated template", () => {
  it("no test file creates an empty scratch database and migrates it itself", () => {
    const offenders: string[] = [];

    for (const name of testFiles()) {
      if (MAY_MIGRATE_THEMSELVES.has(name)) continue;

      const source = readFileSync(path.join(TESTS_DIR, name), "utf8");
      // The slow shape is the PAIR: make an empty database, then run the
      // migrations into it. Either alone is fine — `createScratchDatabase` is
      // still the right call for a file that needs an empty database and never
      // migrates, and a bare `migrate deploy` reference may just be an
      // assertion about the command itself.
      const createsEmpty = source.includes("createScratchDatabase(");
      const migratesItself =
        source.includes("runMigrations(") || source.includes('"migrate", "deploy"');

      if (createsEmpty && migratesItself) offenders.push(name);
    }

    expect(
      offenders,
      "These files create an empty scratch database and then migrate it, which costs " +
        "several seconds of process startup per FILE. Call " +
        "`createMigratedScratchDatabase` instead — it clones a template migrated once " +
        "for the whole run. If the file genuinely needs an unmigrated database (it " +
        "tests the migration, pool, or boot machinery), add it to " +
        "MAY_MIGRATE_THEMSELVES in this file with that reason.",
    ).toEqual([]);
  });

  it("every waived file exists and creates its own unmigrated database", () => {
    // Keeps the waiver list honest: each entry must name a real file that
    // genuinely needs the exemption, so the list stays a precise statement of
    // which files opt out and why.
    const present = new Set(testFiles());

    for (const name of MAY_MIGRATE_THEMSELVES) {
      expect(present.has(name), `${name} is waived but absent from the suite`).toBe(true);

      const source = readFileSync(path.join(TESTS_DIR, name), "utf8");
      const createsEmpty = source.includes("createScratchDatabase(");
      expect(
        createsEmpty,
        `${name} is waived as needing an unmigrated database but does not create one — drop it from MAY_MIGRATE_THEMSELVES`,
      ).toBe(true);
    }
  });
});
