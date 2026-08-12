// A copy of `ensureArea` (../../areas.ts)'s find-or-create-with-
// normalisation semantics, reimplemented against `TransactionHandle`
// instead of a Prisma client's `.area` delegate.
//
// `TransactionHandle` (../context.ts) deliberately exposes only
// `$queryRawUnsafe`/`$executeRawUnsafe` — an operation cannot reach a second
// Prisma client and cannot open a second transaction through it. `ensureArea`
// itself is unusable here for exactly that reason, so this is not a
// shortcut duplicate but the only shape of "ensure an area" an operation
// body is able to call while resolving inside the same transaction as the
// item write it belongs to. Shared by `create-item.ts` and `update-item.ts`
// (`../operations/`) so the normalisation rule lives in one place *within
// the service layer*, even though it is a second copy of the rule
// `areas.ts` states for non-service callers (the importer script).
import type { ServiceContext } from "../context";
import { GuardRejectedError } from "../errors";

/** Same normalisation as `normalizeAreaKey` in areas.ts: lowercase, trim, collapse separators. */
export function normalizeAreaKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Find-or-create an area by normalised id, inside the calling operation's own transaction. */
export async function ensureAreaRaw(ctx: ServiceContext, rawName: string): Promise<string> {
  const id = normalizeAreaKey(rawName);
  if (id === "") {
    throw new GuardRejectedError(
      "items.area.normalises_to_empty",
      `area name normalises to empty: ${JSON.stringify(rawName)}`,
      { fields: ["area"] },
    );
  }
  const displayName = rawName.trim();
  await ctx.db.$executeRawUnsafe(
    `INSERT INTO "Area" ("id", "displayName") VALUES ($1, $2)
     ON CONFLICT ("id") DO NOTHING`,
    id,
    displayName,
  );
  return id;
}
