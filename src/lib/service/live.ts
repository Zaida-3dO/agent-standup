// The composition root: the runtime an adapter actually calls.
//
// The one file in the service layer that reaches the database client and
// the one that owns the process's settings cache. Everything else here
// takes both as parameters, which is why the rest of this directory is
// testable without a database at all — and why §22's import allowlist has
// so little surface to cover.
import { prisma } from "@/lib/prisma";
import { SettingsCache, type SettingsSource, type StoredOverride } from "@/lib/settings";
import { ServiceRuntime, prismaTransactionRunner } from "./runtime";

/**
 * Reads settings out of Postgres, honouring the contract `SettingsSource`
 * states: the revision a snapshot is stamped with is the one read *with*
 * the rows, in the same transaction, not the one that prompted the rebuild.
 */
export const prismaSettingsSource: SettingsSource = {
  async readRevision(): Promise<bigint> {
    const rows = await prisma.$queryRawUnsafe<{ revision: bigint }[]>(
      `SELECT "revision" FROM "settings_revision" WHERE "id" = 1`,
    );
    // No row means the revision table has not been seeded. Zero is the
    // honest answer — the same revision `defaultSnapshot` uses — and it
    // compares unequal to any real revision, so the first real read still
    // rebuilds.
    return rows[0]?.revision ?? 0n;
  },

  async readOverrides(): Promise<{ overrides: StoredOverride[]; revision: bigint }> {
    // One transaction, because a write landing between the two reads would
    // otherwise stamp the snapshot with a revision newer than the rows it
    // holds — and the next revalidation would compare equal and never
    // correct it.
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ key: string; value: unknown }[]>(
        `SELECT "key", "value" FROM "settings"`,
      );
      const revisionRows = await tx.$queryRawUnsafe<{ revision: bigint }[]>(
        `SELECT "revision" FROM "settings_revision" WHERE "id" = 1`,
      );
      return {
        overrides: rows.map((row) => ({ key: row.key, value: row.value })),
        revision: revisionRows[0]?.revision ?? 0n,
      };
    });
  },
};

/** The process's settings cache. One per process, as §17.3 sizes it. */
export const settingsCache = new SettingsCache({ source: prismaSettingsSource });

/**
 * The runtime adapters call.
 *
 * `resolveSnapshot` is the cache's `get`, which serves from memory inside
 * the revalidation interval — so "one snapshot per call" costs a database
 * read only when the revision has actually moved.
 */
export const service = new ServiceRuntime({
  transaction: prismaTransactionRunner(prisma),
  resolveSnapshot: () => settingsCache.get(),
});
