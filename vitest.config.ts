import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // `next/font/local` is a build-time construct the Next compiler
      // resolves and rewrites; it is not a resolvable ES module, so Node
      // reports "Directory import ... is not supported" for it. Nothing
      // here runs the Next compiler, and `src/app/layout.tsx` reaches it
      // transitively through `geist/font/sans`.
      //
      // Aliasing it keeps `tests/root-layout.test.ts` able to import and
      // CALL `RootLayout` as a plain function — which is the whole testing
      // approach this repo is built around (`tests/helpers/react-element.ts`).
      // The alternative was moving the font out of the layout to suit the
      // test, which distorts the source for the test's convenience.
      // See the stub's own header for what this does and does not prove.
      "next/font/local": path.resolve(
        import.meta.dirname,
        "./tests/helpers/next-font-local-stub.ts",
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        // `geist` must be TRANSFORMED, not externalised, or the alias above
        // never gets a chance to apply.
        //
        // Vitest externalises `node_modules` by default and hands them
        // straight to Node's own resolver — which is exactly the resolver
        // that cannot resolve `next/font/local`, so the alias was being
        // bypassed rather than ignored. Inlining routes `geist/font/sans`
        // through Vite's pipeline, where `resolve.alias` applies and the
        // stub is substituted. Scoped to this one package: inlining broadly
        // would slow every run down for no benefit.
        inline: ["geist"],
      },
    },
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
    // The same contention, one phase later. `hookTimeout` covers the setup
    // and teardown spawns; this covers the ones that happen *inside* a test,
    // and Vitest's 5s default is below what several of them legitimately
    // cost:
    //
    //   - `tests/boot.test.ts` runs `prisma migrate deploy` as an assertion
    //     — applying the baseline to a clean database, and proving a broken
    //     migration fails loudly. Each is a process spawn plus real
    //     migration work, and neither declares a timeout of its own.
    //   - `tests/cli-init-dispatch.test.ts` re-imports the CLI's whole
    //     module graph behind `vi.resetModules()`, which is a cold transform
    //     rather than a cached one.
    //
    // Under `npx vitest run` those land beside every other worker competing
    // for the same cores, so a test that takes ~1.4s alone can take several
    // times that in a full run — and the failure it produces is a timeout,
    // which reads as a flake rather than as the resource contention it is.
    // Raising the budget is the honest fix: none of these tests wait on a
    // condition that might never arrive, they do real work whose duration
    // depends on load, so the number that was wrong was the deadline.
    //
    // **This is a ceiling, not a target.** It bounds a hang so a genuinely
    // stuck test still fails the run rather than blocking it forever; a test
    // that becomes slow enough to approach it has a problem this number
    // should not be raised again to hide.
    testTimeout: 30_000,
    // Not a real database — nothing in this suite issues a query. It only
    // needs to be present so PrismaClient's datasource block resolves the
    // env var at construction time.
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
  },
});
