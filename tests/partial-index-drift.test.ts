// Why the hand-written partial indexes do not make `db:check-drift` red.
//
// `prisma/migrations/.../assignment_partial_unique_indexes` contains SQL
// that has no counterpart in `schema.prisma`, because Prisma's schema
// language cannot express a partial index. The obvious worry is that this
// shows up as permanent drift — a migration history that fails to
// reproduce the committed datamodel — which would leave the drift check
// failing on every run and make it useless for catching the thing it
// exists to catch.
//
// It does not, and the reason is worth pinning rather than asserting in
// prose: `prisma migrate diff` compares against the **datamodel**, and a
// partial index has no datamodel representation, so the diff cannot see one
// in either direction. Nothing was suppressed, allowlisted or excepted to
// get that result.
//
// **What this test is for.** That behaviour belongs to Prisma, not to this
// repository, so a future version could change it. If one does, the drift
// check starts failing on a migration nobody touched, and the failure
// arrives as a bare non-zero exit from a script whose message says "run
// prisma migrate dev" — advice that cannot work here, because there is no
// schema.prisma edit that would generate these indexes. This test fails
// first, next to the explanation, so whoever hits it knows immediately that
// the assumption moved rather than that they broke something.
//
// Needs a real, disposable Postgres — the same shadow database the drift
// check itself requires. Skips without one.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

const isWindows = process.platform === "win32";

describeIfDb("partial unique indexes and the migration drift check", () => {
  it("prisma migrate diff reports no difference, despite SQL that schema.prisma cannot express", () => {
    const dbName = scratchDatabaseName("partial_index_drift");
    createScratchDatabase(testDatabaseUrl!, dbName);
    const shadowUrl = new URL(testDatabaseUrl!);
    shadowUrl.pathname = `/${dbName}`;

    try {
      // Exactly the invocation scripts/check-migration-drift.mjs makes.
      // Run directly rather than through the script so the assertion is
      // on Prisma's own answer, not on the wrapper's exit code — the
      // wrapper could be edited to swallow a failure, and this test
      // would then be certifying the wrapper instead of the behaviour.
      const result = spawnSync(
        isWindows ? "npx.cmd" : "npx",
        [
          "prisma",
          "migrate",
          "diff",
          "--from-migrations",
          "prisma/migrations",
          "--to-schema-datamodel",
          "prisma/schema.prisma",
          "--shadow-database-url",
          shadowUrl.toString(),
          "--exit-code",
        ],
        { encoding: "utf-8", shell: isWindows },
      );

      // `--exit-code` makes this 0 only when there is genuinely no
      // difference; 2 means drift was found. Asserting on the status
      // AND on the reported text, because a Prisma version that changed
      // its exit conventions would otherwise pass this silently.
      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("No difference detected");
    } finally {
      dropScratchDatabase(testDatabaseUrl!, dbName);
    }
  }, 120_000);
});
