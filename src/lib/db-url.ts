// Deliberate Postgres connection-pool sizing for the Prisma client singleton
// (see prisma.ts). Full reasoning lives in the PR description; summary:
//
// - This process is a single, long-lived Next.js standalone server, not
//   serverless/edge — the singleton in prisma.ts guarantees exactly one
//   `PrismaClient` per container, so these two numbers describe the whole
//   app's worst-case Postgres usage, not a per-request slice of it.
// - `connection_limit` bounds how many connections the pool will ever open.
//   Postgres's own default `max_connections` is 100, and this app is meant
//   to be the sole tenant of its database — but that database still needs
//   headroom for `prisma migrate deploy` at boot, `prisma studio`, and a
//   person on `psql`. A deliberate `DEFAULT_CONNECTION_LIMIT` leaves most of
//   that headroom spare instead of drifting with whatever Prisma's own
//   `num_cpus * 2 + 1` default happens to compute on a given host.
// - `pool_timeout` bounds how long a query queues for a connection before
//   giving up. Left unset, Prisma's own default (10s) already does this —
//   but leaving it implicit means the value isn't visible or reasoned about
//   anywhere in this codebase. Pinning it here makes "how long do we wait
//   before giving the caller a typed, catchable error instead of a silent
//   hang" a decision this file states outright.
export const DEFAULT_CONNECTION_LIMIT = 10;
export const DEFAULT_POOL_TIMEOUT_SECONDS = 10;

export interface PoolDefaults {
  connectionLimit?: number;
  poolTimeoutSeconds?: number;
}

/**
 * Returns `databaseUrl` with `connection_limit` and `pool_timeout` query
 * params applied, UNLESS the operator already set one — an explicit value on
 * `DATABASE_URL` always wins, so pooling can be retuned per-deployment
 * without a code change.
 */
export function withPoolDefaults(databaseUrl: string, defaults: PoolDefaults = {}): string {
  const url = new URL(databaseUrl);
  const connectionLimit = defaults.connectionLimit ?? DEFAULT_CONNECTION_LIMIT;
  const poolTimeoutSeconds = defaults.poolTimeoutSeconds ?? DEFAULT_POOL_TIMEOUT_SECONDS;

  if (!url.searchParams.has("connection_limit")) {
    url.searchParams.set("connection_limit", String(connectionLimit));
  }
  if (!url.searchParams.has("pool_timeout")) {
    url.searchParams.set("pool_timeout", String(poolTimeoutSeconds));
  }

  return url.toString();
}
