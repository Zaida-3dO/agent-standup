// "Never mints the same thing twice" — MILESTONES.md #63, DECISIONS.md §13.
//
// ── The claim this module makes, and where it is actually enforced ──────
//
// §13 settles identity: *"has this file been minted from?"* is
// `SELECT 1 FROM items WHERE source_ref = (path, hash)`, and there is no
// `sources` table because `items.source_ref` **is** the record.
//
// That query is the right question and, on its own, the wrong mechanism.
// A read followed by a write is idempotent only when nothing commits in
// between, and two scans that overlap are exactly the case where something
// does: both read "no row", both conclude "not minted", both insert. Under
// READ COMMITTED neither can see the other's uncommitted row, so this is
// not an unlucky interleaving to be narrowed — it is the expected result,
// and the window is as wide as the mint itself.
//
// **So the dedup check is a unique index, and this module is the code that
// respects it.** `Item_sourceRef_unique` (migration
// 20260831090000_minting_source_ref_unique) is a partial unique index on
// `"sourceRef" WHERE "sourceRef" IS NOT NULL`. The insert is attempted and
// a unique violation is read as "somebody else minted this first" — a
// normal, expected outcome returned as a value, not an error to surface.
//
// Two properties fall out of putting it there rather than here, and both
// are the requirement rather than a nicety:
//
//   - **Across concurrent scans.** The loser of the race is refused by
//     Postgres at write time, whatever it read beforehand.
//   - **Across a restart.** A lock, a cache or an in-process set of seen
//     hashes lives in one process and dies with it. A constraint is a
//     property of the data and is still enforcing after the process is
//     replaced — which is the half of the requirement no application-level
//     guard can meet at all.
//
// ── Why the pre-check stays anyway ─────────────────────────────────────
//
// `findMintedItem` below is NOT the dedup mechanism and must never be
// mistaken for it. It is there because the ordinary case is "already
// minted" — a scan re-reads the same unchanged files every tick — and
// reaching that answer with a read is cheaper than reaching it by
// attempting an insert and rolling back. Deleting it would leave the
// system correct and slower; deleting the constraint would leave it fast
// and wrong.
import { Prisma } from "@prisma/client";
import type { TransactionHandle } from "@/lib/service/context";
import { SOURCE_REF_SEPARATOR } from "./source-ref";

/**
 * Postgres's unique-violation SQLSTATE, as Prisma surfaces it.
 *
 * `P2002` is Prisma's own code for "unique constraint failed" and is what a
 * `PrismaClientKnownRequestError` carries; the raw driver reports `23505`.
 * Both are matched, because a mint attempted through `$executeRaw` (which
 * the scan does not do today, but a batching variant might) surfaces the
 * latter.
 */
export const PRISMA_UNIQUE_VIOLATION = "P2002";
export const POSTGRES_UNIQUE_VIOLATION = "23505";

/**
 * Whether an error is the database refusing a duplicate.
 *
 * **Narrow on purpose.** Treating any write failure as "already minted"
 * would silently swallow a genuine defect — a null in a required column, a
 * foreign key to a missing area — and report a mint that never happened as
 * an idempotent no-op, which is the one lie this module must not tell. A
 * failure this does not recognise is rethrown.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === PRISMA_UNIQUE_VIOLATION;
  }
  const code = (error as { code?: unknown } | null)?.code;
  return code === POSTGRES_UNIQUE_VIOLATION;
}

/** What one attempt to mint from a source produced. */
export type MintOutcome<T> =
  /** This call inserted the row. Exactly one caller ever sees this for a given ref. */
  | { readonly minted: true; readonly item: T }
  /**
   * The source was already minted — by an earlier scan, or by a concurrent
   * one that won the race. `raced` distinguishes the two, which matters only
   * for telemetry and for tests: the caller's behaviour is identical.
   */
  | { readonly minted: false; readonly itemId: string | null; readonly raced: boolean };

/**
 * The item already minted from this exact source version, if there is one.
 *
 * Equality on the whole `path@hash` ref, so an edited file (whose hash has
 * moved) does not match and is eligible again — §13's *"editing a file
 * changes its hash, so it becomes eligible again"*.
 */
export async function findMintedItem(
  db: TransactionHandle,
  sourceRef: string,
): Promise<{ id: string } | null> {
  // `$queryRawUnsafe` with a bound parameter, not string interpolation:
  // `TransactionHandle` (src/lib/service/context.ts) exposes only the
  // `Unsafe` variants, and "unsafe" there names the *query text* being a
  // plain string. `$1` is still a real bind parameter, so `sourceRef` — a
  // path that came off a filesystem — is never concatenated into SQL.
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "Item" WHERE "sourceRef" = $1 LIMIT 1`,
    sourceRef,
  );
  return rows[0] ?? null;
}

/**
 * Every item minted from any version of this path — §13's *"the agent is
 * told which items already came from the previous version"*.
 *
 * A prefix match rather than an equality, which is why the non-unique
 * `Item_sourceRef_idx` is still worth its place: the unique index answers
 * "this exact version" and cannot answer this.
 *
 * `path` is escaped for `LIKE` before interpolation. A path containing `%`
 * or `_` is legal on every filesystem this runs on, and without escaping
 * one would silently match unrelated sources — a wildcard nobody typed.
 */
export async function findItemsFromPath(
  db: TransactionHandle,
  path: string,
): Promise<{ id: string; sourceRef: string | null }[]> {
  const escaped = path.replace(/([\\%_])/g, "\\$1");
  return db.$queryRawUnsafe<{ id: string; sourceRef: string | null }[]>(
    `SELECT "id", "sourceRef" FROM "Item"
     WHERE "sourceRef" LIKE $1 ESCAPE '\\'
     ORDER BY "createdAt" ASC`,
    `${escaped}${SOURCE_REF_SEPARATOR}%`,
  );
}

/**
 * Runs `insert` at most once for `sourceRef`, ever.
 *
 * The caller supplies the insert because *what* to mint is the scanner's
 * business and *how many times* is this module's. `insert` must be the
 * write that carries the `sourceRef` — a caller that inserted a row without
 * it would be outside the constraint and outside this guarantee.
 *
 * **Ordering is: check, insert, and let the constraint arbitrate.** The
 * check can be stale by the time the insert runs; that is expected and is
 * precisely why the third step exists.
 *
 * ⚠️ **`insert` must not be run in a transaction this function shares with
 * later work.** A unique violation aborts the surrounding Postgres
 * transaction, so anything the caller does afterwards on the same handle
 * fails with "current transaction is aborted". The scanner therefore calls
 * this once per source on its own transaction (see `runMintScan`), which
 * is also what keeps one poisoned source from failing a whole scan.
 */
export async function mintOnce<T extends { id: string }>(
  db: TransactionHandle,
  sourceRef: string,
  insert: (db: TransactionHandle) => Promise<T>,
): Promise<MintOutcome<T>> {
  const existing = await findMintedItem(db, sourceRef);
  if (existing) return { minted: false, itemId: existing.id, raced: false };

  try {
    return { minted: true, item: await insert(db) };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost the race. The winner's row is committed by the time the
    // violation is raised, but it is not necessarily visible to THIS
    // transaction's snapshot — under REPEATABLE READ it is not — so the id
    // is reported as unknown rather than looked up and wrongly reported as
    // absent. "Already minted" is the answer that matters and it is
    // certain; the id is a convenience.
    return { minted: false, itemId: null, raced: true };
  }
}
