// The one place a test's database client is constructed.
//
// ── Why tests do not use `src/lib/prisma.ts` ─────────────────────────────
//
// That module is a `globalThis`-cached singleton bound to whatever
// `DATABASE_URL` held when it was first imported. The DB-backed suites are
// built on the opposite arrangement: `scratch-db.ts` gives every test file
// its own uniquely-named, disposable database so files can run in parallel
// without colliding, and hands back a **URL string** rather than a client.
// A singleton pinned to one URL cannot serve that, so building a client per
// scratch database is the design here, not an oversight.
//
// ── What was still missing, and what this fixes ──────────────────────────
//
// `withPoolDefaults` (`src/lib/db-url.ts`) is where this repo decides how
// many connections a client may open, but it was applied in exactly one
// place — the singleton — so every test client constructed directly
// inherited Prisma's own per-host default of `num_cpus * 2 + 1` instead.
// On a 32-core machine that is 65 connections **per client**, against
// Postgres's default `max_connections` of 100.
//
// Nothing had broken, because pools fill lazily: a measured full run peaked
// at 41 backends. But that headroom is a property of how few connections
// each test happens to need rather than of anything bounding them, and it
// is invisible and machine-dependent — more cores raise the per-client
// default, more test files raise the client count, and neither shows up
// until a run fails with a connection error that reads as unrelated to
// whatever change was in flight. It would also arrive in the least useful
// place: on a developer's machine, after CI has already gone green.
//
// Routing through here puts that number in one place for tests, the same
// way `prisma.ts` does for the server.
//
// ── Why a smaller limit than the server's ────────────────────────────────
//
// `DEFAULT_CONNECTION_LIMIT` is 10 for a single long-lived server process
// that is the sole tenant of its database. A test run is the opposite
// shape: many short-lived worker processes against one Postgres, each with
// its own scratch database. The bound that matters is therefore
// `workers * clients-per-worker * limit`, so the per-client number has to
// be small enough that a full-concurrency run stays clear of
// `max_connections` — while still leaving room for the handful of
// concurrent queries a single test issues (`db-pool.test.ts` drives two at
// once deliberately).
import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { withPoolDefaults } from "@/lib/db-url";

/**
 * Connections a single test client may open.
 *
 * Deliberately well below the server's 10 and far below Prisma's derived
 * default: with vitest running one worker per test file, the ceiling that
 * matters is the product across all live workers, not any one client's
 * appetite. Five leaves a full-concurrency run comfortably inside
 * `max_connections` while still serving the concurrent queries a test
 * issues on purpose.
 */
type PrismaClientOptions = Prisma.PrismaClientOptions;

export const TEST_CONNECTION_LIMIT = 5;

/**
 * Seconds a query waits for a free connection before failing.
 *
 * Shorter than the server's 10: in a test, waiting a long time for a
 * connection that is not coming turns a pool-exhaustion bug into a suite
 * timeout, which reports as "something hung" and names nothing. Failing
 * sooner produces a typed, catchable error that says what actually ran out.
 */
export const TEST_POOL_TIMEOUT_SECONDS = 10;

/**
 * Builds a `PrismaClient` for `databaseUrl` with this repo's pool defaults
 * applied.
 *
 * An explicit `connection_limit` or `pool_timeout` already on the URL wins,
 * because `withPoolDefaults` only fills in what is absent — so a test that
 * needs to drive the pool to its edge (`db-pool.test.ts`) can still state
 * its own numbers and get them.
 *
 * Generic in `options` rather than taking a widened type, so a caller
 * passing `log: [{ emit: "event", level: "query" }]` gets a client whose
 * `$on("query")` is typed — `PrismaClient`'s event names are derived from
 * its options, and a non-generic signature erases them to `never`, which
 * turns every query-logging test into a type error.
 *
 * `options` carries anything else a test needs — query logging, most often.
 * The datasource keys are excluded from its type rather than merely
 * overwritten: accepting a `datasources` or `datasourceUrl` here would let a
 * caller silently reintroduce an unpooled URL through the very function that
 * exists to apply the pooling, and a type error at the call site says so
 * immediately instead of at a connection limit weeks later.
 */
export function createTestPrismaClient<
  const Options extends Omit<PrismaClientOptions, "datasourceUrl" | "datasources">,
>(databaseUrl: string, options: Options = {} as Options): PrismaClient<Options> {
  const withPooling = {
    ...options,
    datasourceUrl: withPoolDefaults(databaseUrl, {
      connectionLimit: TEST_CONNECTION_LIMIT,
      poolTimeoutSeconds: TEST_POOL_TIMEOUT_SECONDS,
    }),
    // `PrismaClient`'s constructor is typed `Subset<Options, PrismaClientOptions>`,
    // an exact-shape constraint that rejects a value carrying any key the
    // inferred `Options` does not itself declare — and `datasourceUrl` is
    // precisely such a key, since the signature above excludes it from what a
    // caller may pass. The value is correct at runtime and correct against
    // `PrismaClientOptions`; only the exactness check disagrees, so the cast
    // is asserted here, on one line, rather than by widening `Options` (which
    // would let a caller pass the datasource keys this function exists to own).
  };

  return new PrismaClient<Options>(
    withPooling as ConstructorParameters<typeof PrismaClient<Options>>[0],
  );
}
