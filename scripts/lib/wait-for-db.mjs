#!/usr/bin/env node
// Bounded retry loop that waits for Postgres to actually accept a query, not
// just a TCP handshake — a database mid-recovery can accept the socket and
// still refuse queries. Used by scripts/entrypoint.mjs *before* it ever
// attempts `prisma migrate deploy`, so a cold-starting or not-yet-reachable
// Postgres (there is no `depends_on: condition: service_healthy` guarding
// this in every deployment shape — see docker-compose.prod.yml) doesn't
// immediately crash the app container; it waits, then gives up loudly if the
// database genuinely never comes up.
import { PrismaClient } from "@prisma/client";

export class DatabaseUnreachableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DatabaseUnreachableError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Prisma's connection errors are multi-line with blank separator lines
// (e.g. "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nCan't reach
// database server..."); a plain first-line grab lands on that leading blank
// line. Collapse to the meaningful text on one line instead, so the retry
// log is actually useful to whoever's watching it.
function summarize(value) {
  return String(value?.message ?? value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * @typedef {{ info: (message: string) => void, warn: (message: string) => void, error: (message: string, err?: unknown) => void }} Logger
 */

/**
 * Resolves once `SELECT 1` succeeds against `databaseUrl`, or rejects with a
 * `DatabaseUnreachableError` once `timeoutMs` has elapsed without success.
 *
 * @param {{ databaseUrl?: string, timeoutMs?: number, intervalMs?: number, log?: Logger }} [options]
 */
export async function waitForDatabase({
  databaseUrl,
  timeoutMs = 60_000,
  intervalMs = 2_000,
  log = console,
} = {}) {
  if (!databaseUrl) {
    throw new DatabaseUnreachableError("DATABASE_URL is not set.");
  }

  const deadline = Date.now() + timeoutMs;
  let lastError;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const probe = new PrismaClient({ datasourceUrl: databaseUrl });
    try {
      await probe.$queryRaw`SELECT 1`;
      await probe.$disconnect();
      log.info(`Database reachable after ${attempt} attempt(s).`);
      return;
    } catch (err) {
      lastError = err;
      await probe.$disconnect().catch(() => {});

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      log.warn(`Database not ready yet (attempt ${attempt}: ${summarize(err)}); retrying...`);
      await sleep(Math.min(intervalMs, remaining));
    }
  }

  throw new DatabaseUnreachableError(
    `Database still unreachable after ${timeoutMs}ms across ${attempt} attempt(s).`,
    { cause: lastError },
  );
}
