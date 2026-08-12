#!/usr/bin/env node
// Proves the connection `standup init` is about to write into local
// configuration is actually usable, with a genuine write and a genuine read
// — not merely "the socket connected" (docs/plans/MILESTONES.md #80: "prove
// it with a live round trip").
//
// Deliberately independent of the application schema: it creates a
// **session-temporary** table, writes one row, reads it back and asserts the
// value survived, then disconnects. `CREATE TEMP TABLE` needs only the `TEMP`
// privilege on the *database*, which Postgres grants to every role by
// default — not `CREATE` on the `public` schema, which the application role
// deliberately does not have (scripts/lib/provision-db.mjs grants it only
// SELECT/INSERT/UPDATE/DELETE). A temp table is dropped automatically when
// its session ends, so this leaves **zero** rows behind either way — no
// residue in a fresh install's item list, no cleanup step that itself could
// fail and leave a mess.
//
// Constructs a `PrismaClient` directly, unlike everything under `src/lib/`:
// this file lives under `scripts/`, which is not part of the database-import
// allowlist restriction in the first place (CLAUDE.md, "Working in this
// repo" — the restriction is scoped to `src/`). Same posture as
// `scripts/lib/wait-for-db.mjs`.
import { PrismaClient } from "@prisma/client";

export class RoundTripFailedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "RoundTripFailedError";
  }
}

/**
 * @typedef {{ info: (message: string) => void, warn: (message: string) => void, error: (message: string, err?: unknown) => void }} Logger
 */

/**
 * Writes one row to a temp table and reads it back against `databaseUrl`.
 * Throws `RoundTripFailedError` if the connection cannot be made, the write
 * fails, or the value read back does not match what was written — the same
 * distinction `wait-for-db.mjs` draws between "not reachable yet" and
 * "reachable but wrong", except here there is no retry: this runs once,
 * against a connection `standup init` is about to trust.
 *
 * @param {{ databaseUrl: string, log?: Logger }} options
 */
export async function verifyRoundTrip({ databaseUrl, log = console }) {
  if (!databaseUrl) {
    throw new RoundTripFailedError("No connection string was given to verify.");
  }

  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  const marker = `standup-init-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    await prisma.$executeRawUnsafe(
      `CREATE TEMP TABLE "standup_init_round_trip" ("value" text NOT NULL)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "standup_init_round_trip" ("value") VALUES ($1)`,
      marker,
    );
    const rows = await prisma.$queryRawUnsafe(`SELECT "value" FROM "standup_init_round_trip"`);

    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.value !== marker) {
      throw new RoundTripFailedError(
        "The value read back did not match the value written — the connection accepted the " +
          "write but did not return it faithfully.",
      );
    }

    log.info("Live round trip succeeded: wrote a row and read it back unchanged.");
  } catch (cause) {
    if (cause instanceof RoundTripFailedError) throw cause;
    throw new RoundTripFailedError("Could not complete a write-then-read against the database.", {
      cause,
    });
  } finally {
    // The temp table is dropped automatically when the session ends, which
    // this triggers — no explicit DROP TABLE needed, and none would help if
    // the connection itself were the problem.
    await prisma.$disconnect().catch(() => {});
  }
}
