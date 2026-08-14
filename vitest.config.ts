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
    // Not a real database — nothing in this suite issues a query. It only
    // needs to be present so PrismaClient's datasource block resolves the
    // env var at construction time.
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
  },
});
