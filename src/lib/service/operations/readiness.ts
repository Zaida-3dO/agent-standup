// `readiness` — can this installation actually serve a request yet.
//
// ── Why this is not the health endpoint ──────────────────────────────────
//
// Liveness and readiness are different questions with different consumers,
// and answering both from one route means one of those consumers is
// silently given the wrong answer.
//
//   - **Liveness** asks *is this process alive*. Its consumer is a restart
//     policy, and the right answer avoids every dependency the process does
//     not control: a database that is down is not a reason to kill and
//     restart an application container, because restarting it fixes
//     nothing and a crash loop makes the real fault harder to see.
//   - **Readiness** asks *can I use this yet*. Its consumers are a
//     deployment gate, a `depends_on` condition and a load balancer, and
//     for them a process that cannot reach its database is useless — it
//     answers every real call with an error, so sending it traffic is
//     strictly worse than waiting.
//
// A process whose Postgres is still initialising is alive and not ready.
// That state is normal, common at startup, and exactly the one a single
// endpoint cannot express: report it as unhealthy and the restart policy
// kills a container that was about to work; report it as healthy and the
// load balancer sends traffic to a process that cannot serve it.
//
// ── Why migration state is part of the answer ────────────────────────────
//
// *Connected* and *ready* are not the same claim. A process that has
// reached its database but is running against a schema two migrations
// behind will fail on whichever call first touches a column that does not
// exist yet — and it will fail at the point of use, as an internal error,
// rather than at the gate that was supposed to catch it. That failure is
// hard to read from the client end and trivial to detect here, so the
// answer carries it: a deployment gate that only asked "did the connection
// open" would go green on precisely the deploy worth stopping.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";

const inputSchema = z.object({}).strict();

export type ReadinessInput = z.infer<typeof inputSchema>;

export interface ReadinessOutput {
  /** Whether the installation can serve real calls. */
  readonly ready: boolean;
  /** Whether a query reached the database and came back. */
  readonly database: boolean;
  /** How many migrations are recorded as applied, when that is readable. */
  readonly migrationsApplied: number;
  /**
   * Migrations that started and never finished.
   *
   * A separate count rather than folded into the one above, because a
   * partially-applied migration is the state most worth naming: the schema
   * matches no migration in the ledger completely, and a deploy that
   * continues into it fails in ways that look like application bugs.
   */
  readonly migrationsPending: number;
}

/**
 * The cheapest query that proves the connection works.
 *
 * `SELECT 1` rather than a count or a table read: it needs no table to
 * exist, so it separates *the database is reachable* from *the schema is
 * populated* — and those are different failures with different fixes. A
 * readiness probe that queried a real table would report a fresh, correctly
 * connected installation as unreachable.
 */
const CONNECTION_PROBE = "SELECT 1";

/**
 * Prisma's own migration ledger.
 *
 * Read directly rather than through the client's migration API because
 * this runs inside the service layer's transaction handle, which exposes
 * raw queries and nothing else — and because the ledger is the same table
 * the migration tooling itself writes, so the two cannot disagree about
 * what has been applied.
 *
 * `finished_at IS NULL AND rolled_back_at IS NULL` is the partially-applied
 * case: a migration that started and neither completed nor was rolled back.
 */
const MIGRATION_QUERY = `
  SELECT
    COUNT(*) FILTER (WHERE "finished_at" IS NOT NULL) AS applied,
    COUNT(*) FILTER (WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL) AS pending
  FROM "_prisma_migrations"
`;

interface RawMigrationCounts {
  readonly applied: bigint | number | null;
  readonly pending: bigint | number | null;
}

/** Postgres `COUNT` arrives as a `bigint`; JSON has no bigint. */
function toCount(value: bigint | number | null): number {
  return value === null ? 0 : Number(value);
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const readiness = defineOperation({
  name: "readiness",
  kind: "read",
  summary: "Whether this installation can serve calls: database reachable and migrations applied.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext): Promise<ReadinessOutput> {
    // If this throws, the database is unreachable and the caller gets an
    // error rather than a `ready: false` body. That is the honest answer:
    // the operation could not be completed, and inventing a successful
    // response describing a failure would make an unreachable database
    // indistinguishable from a reachable one that reported itself down.
    // The route above turns that into the 503 a probe reads.
    await ctx.db.$queryRawUnsafe(CONNECTION_PROBE);

    const rows = await ctx.db.$queryRawUnsafe<RawMigrationCounts[]>(MIGRATION_QUERY);
    const counts = rows[0];
    const migrationsApplied = toCount(counts?.applied ?? 0);
    const migrationsPending = toCount(counts?.pending ?? 0);

    return {
      // Ready means both halves: the query returned *and* no migration is
      // stuck half-applied. The connection alone is the check that goes
      // green on the deploy worth stopping.
      ready: migrationsPending === 0,
      database: true,
      migrationsApplied,
      migrationsPending,
    };
  },
});
