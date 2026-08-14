// The composition root: the runtime an adapter actually calls.
//
// The one file in the service layer that reaches the database client and
// the one that owns the process's settings cache. Everything else here
// takes both as parameters, which is why the rest of this directory is
// testable without a database at all — and why §22's import allowlist has
// so little surface to cover.
import { prisma } from "@/lib/prisma";
import { SettingsCache, type SettingsSource, type StoredOverride } from "@/lib/settings";
import { ServiceRuntime, prismaTransactionRunner, type CallOptions } from "./runtime";
// Side-effect import: every hand-written guard under `src/lib/service/guards/`
// registers into the shared `guardRegistry` as a side effect of importing
// this module — see that module's own header. Imported here, not in
// state-machine/index.ts, so a test that only wants the framework
// (state-machine-transition.test.ts, which builds its own scratch
// GuardRegistry per test) never pulls in guards it did not ask for — only
// the real composition root does.
import "./guards";

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
 * The operations that change settings, and so make the held snapshot stale.
 *
 * Exactly the operations that call `bumpRevision` — "changed the settings"
 * and "moved the revision" are the same event, which is what makes this list
 * checkable rather than remembered: `tests/settings-cache-invalidation.test.ts`
 * asserts it matches the set of operation modules that bump, so adding a
 * fourth settings writer without adding it here fails.
 */
export const SETTINGS_WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  "put_setting",
  "delete_setting",
  "patch_settings",
]);

/**
 * The runtime adapters call.
 *
 * `resolveSnapshot` is the cache's `get`, which serves from memory inside
 * the revalidation interval — so "one snapshot per call" costs a database
 * read only when the revision has actually moved.
 *
 * **Invalidation lives here, not in the adapters.** `cache.ts` documents
 * invalidating after a write as the writing process's own obligation — the
 * "immediate in the process that made the change" half of the guarantee —
 * and nothing was discharging it, so a setting written through any adapter
 * could stay invisible to that same process for the whole revalidation
 * interval. Every caller that writes a setting and then depends on it
 * taking effect could read the old value, and a test faster than the
 * interval would fail intermittently long before anyone recognised the
 * cause.
 *
 * Doing it in the composition root rather than in each route fixes every
 * adapter at once — HTTP, the CLI's in-process binding, MCP and any future
 * one — because they all call through this runtime. An adapter-by-adapter
 * fix would leave the obligation restated in each new adapter, where the
 * cost of forgetting is silent staleness rather than a failure.
 *
 * Only on success: a write that threw changed nothing, and discarding the
 * snapshot then would turn every rejected write into an extra database
 * round trip for no reason.
 */
class SettingsInvalidatingRuntime extends ServiceRuntime {
  async call(name: string, input: unknown, options?: CallOptions): Promise<unknown> {
    const result = await super.call(name, input, options);
    if (SETTINGS_WRITE_OPERATIONS.has(name)) settingsCache.invalidate();
    return result;
  }
}

export const service: ServiceRuntime = new SettingsInvalidatingRuntime({
  transaction: prismaTransactionRunner(prisma),
  resolveSnapshot: () => settingsCache.get(),
});
