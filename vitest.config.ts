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
    // Bounds how many test files run at once. Configured here, deliberately,
    // rather than left to a `--maxWorkers` flag on the command line: the
    // person who most needs this cap is the one who has not yet met the
    // failure it prevents, and they have no reason to type a flag for a
    // problem they do not know they have.
    //
    // ── What goes wrong without it ──────────────────────────────────────
    //
    // Vitest defaults to one worker per core. On a 32-core machine that is
    // 32 test files running at once, and the suite then fails 1-3 files per
    // run with a DIFFERENT set failing each time. Measured on this repo at
    // an unmodified `main`, three consecutive uncapped runs gave: one failed
    // file, then two entirely different failed files, then a clean pass.
    //
    // The failures are TIMEOUTS, not errors — tests whose own polling
    // deadline (`tests/since-operations.test.ts` waits 15s for a write to
    // become visible) expires while the worker is starved of CPU. That is
    // what makes this worth a config entry rather than a known annoyance:
    // a timeout reads as a flaky test, so the cost lands as misattribution.
    // This repository has already paid for that exact mistake once, when a
    // test failing ~45% of the time was recorded as flaky, documented as
    // flaky and briefed as flaky, and was actually the merge gate approving
    // superseded work. "Flaky" is a hypothesis, not a diagnosis.
    //
    // ── Why 8, and why raising it is not free ───────────────────────────
    //
    // 8 is not a compromise against speed — it is FASTER than uncapped.
    // Full-suite wall time, measured on a 32-core machine against a real
    // Postgres:
    //
    //     32 workers (default)   72s wall   — vitest self-reports 1738s of
    //                                         test time, and fails randomly
    //      8 workers             58s wall   — 304s of test time, green
    //      4 workers            140s wall   — 323s of test time, green
    //
    // The per-test time inflating 5.4x from 8 workers to 32, for identical
    // assertions, is the contention itself: past ~8 the workers spend their
    // slice competing rather than working. So the usual reason to raise this
    // number does not apply — it buys slower runs and random failures.
    //
    // A second, independent ceiling argues the same way, and it is the one
    // that bites hardest on a bigger machine. 114 test files construct their
    // own `new PrismaClient({ datasourceUrl })` against a scratch database
    // WITHOUT going through `withPoolDefaults` (see `src/lib/db-url.ts` —
    // `src/lib/prisma.ts` is its only caller), so each inherits Prisma's own
    // default pool of `num_cpus * 2 + 1`: 65 connections per client here.
    // Postgres ships `max_connections = 100`. Peak observed usage was 41 at
    // 32 workers and 16 at 8, because pools fill lazily under this suite's
    // light per-file query load — so that headroom is luck rather than
    // design, and a worker count near the core count on a larger host is
    // what would convert it into connection exhaustion.
    //
    // Raising this needs evidence against BOTH: that the run got faster,
    // and that peak backends stayed clear of `max_connections`.
    maxWorkers: 8,
    // Not a real database — nothing in this suite issues a query. It only
    // needs to be present so PrismaClient's datasource block resolves the
    // env var at construction time.
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    },
  },
});
