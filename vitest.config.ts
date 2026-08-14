import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Builds one migrated template database the DB-backed files clone, instead
    // of each of them replaying every migration through its own `npx` spawn.
    // See tests/helpers/global-setup.ts for why that dominated the suite.
    globalSetup: ["tests/helpers/global-setup.ts"],
    // Each DB-backed file creates and drops its own database through the
    // `prisma` CLI, and every such call is a process spawn costing seconds —
    // more when many files run at once, because `CREATE DATABASE ... TEMPLATE`
    // takes an exclusive lock on the template and serialises the clones. The
    // 10s default is below that under full parallelism, and it bites in
    // `afterAll` (dropping the database), where a timeout fails an entire file
    // whose assertions have all already passed.
    hookTimeout: 60_000,
    // Not a real database — nothing in this suite issues a query. It only
    // needs to be present so PrismaClient's datasource block resolves the
    // env var at construction time.
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
  },
});
