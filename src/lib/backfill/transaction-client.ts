// Lets the importers run inside a service operation's transaction.
//
// The three importers were written to take a Prisma client, because they
// also run from a script. A service operation is handed a `TransactionHandle`
// instead — deliberately narrow, exposing only `$queryRawUnsafe` and
// `$executeRawUnsafe`, so that an operation body cannot reach a second
// client or open a nested transaction (`../service/context.ts`).
//
// This module bridges the two: it presents the *exact* slice of the Prisma
// client surface the importers actually call, implemented as raw SQL
// against one transaction handle. The alternative — reimplementing the
// inserts inside the operation — would put a second copy of every write in
// the codebase and make the importers no longer the single writer to their
// own tables. A narrow, honest adapter is the cheaper of the two.
//
// **It implements only the call shapes the importers use**, not Prisma's
// query language. `findFirst` understands one `where` clause (the
// `custom_fields.legacy_id` lookup all three importers share) and refuses
// anything else rather than quietly returning the wrong row; `create`
// understands the column set `importItems` writes. That narrowness is the
// safety property: a future caller passing a query this cannot express gets
// an error, not a plausible-looking wrong answer.
import type { TransactionHandle } from "../service/context";
import type { BackfillClient } from "./run";

export class UnsupportedQueryError extends Error {
  constructor(what: string) {
    super(
      `${what} — this transaction-backed client implements only the queries the importers issue, ` +
        "and refuses anything else rather than returning a plausible wrong answer",
    );
    this.name = "UnsupportedQueryError";
  }
}

/** Columns `importItems` writes, with the cast each needs to reach its Postgres type. */
const COLUMN_CASTS: Record<string, string> = {
  id: "",
  kind: '::"ItemKind"',
  title: "",
  body: "",
  state: '::"ItemState"',
  originType: '::"OriginType"',
  area: "",
  repo: "",
  mergeAuthority: '::"MergeAuthority"',
  priority: '::"Priority"',
  branch: "",
  needsVisualReview: "::boolean",
  sourceRef: "",
  customFields: "::jsonb",
};

/**
 * Rebuilds a Prisma tagged-template call (`$queryRaw`/`$executeRaw`) as a
 * parameterised statement.
 *
 * The interpolations become `$1`, `$2`, … in order, which is exactly what
 * the tagged form means — so a value can never be spliced into the SQL
 * text, only bound. `ensureArea` (`../areas.ts`) is the one caller; it is
 * reached through this rather than reimplemented so that the area
 * normalisation and its atomic `ON CONFLICT DO NOTHING` insert stay stated
 * in one place.
 */
function taggedTemplate<T>(
  run: (sql: string, ...values: unknown[]) => Promise<T>,
): (strings: TemplateStringsArray, ...values: unknown[]) => Promise<T> {
  return (strings, ...values) => {
    let sql = "";
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i]!;
      if (i < values.length) sql += `$${i + 1}`;
    }
    return run(sql, ...values);
  };
}

interface LegacyIdWhere {
  customFields?: { path?: string[]; equals?: unknown };
}

/** Reads the one `where` clause this client supports, or refuses. */
function legacyIdOf(where: unknown): string {
  const clause = (where ?? {}) as LegacyIdWhere;
  const path = clause.customFields?.path;
  const equals = clause.customFields?.equals;
  if (!Array.isArray(path) || path.length !== 1 || path[0] !== "legacy_id") {
    throw new UnsupportedQueryError("findFirst supports only the custom_fields.legacy_id lookup");
  }
  if (typeof equals !== "string") {
    throw new UnsupportedQueryError("findFirst requires a string legacy_id to match");
  }
  return equals;
}

/**
 * A `BackfillClient` backed by one transaction handle.
 *
 * Every write the importers make therefore lands in the caller's own
 * transaction and rolls back with it — a backfill that fails partway
 * through leaves no half-imported rows, which for a bulk write of this size
 * is the difference between "run it again" and "work out what landed".
 */
export function transactionBackedClient(db: TransactionHandle): BackfillClient {
  const findFirst = async (args: { where?: unknown }) => {
    // `SELECT *` regardless of any `select` the caller passed: returning
    // more columns than were asked for is harmless to every caller here,
    // and the column names are already the camelCase the callers read.
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "Item" WHERE "customFields"->>'legacy_id' = $1 LIMIT 1`,
      legacyIdOf(args?.where),
    );
    return rows[0] ?? null;
  };

  const create = async (args: { data: Record<string, unknown> }) => {
    const entries = Object.entries(args.data).filter(([, value]) => value !== undefined);
    const unknownColumn = entries.find(([column]) => !(column in COLUMN_CASTS));
    if (unknownColumn) {
      throw new UnsupportedQueryError(`create cannot write the column ${unknownColumn[0]}`);
    }

    const columns = entries.map(([column]) => `"${column}"`).join(", ");
    const placeholders = entries
      .map(([column], index) => `$${index + 1}${COLUMN_CASTS[column]}`)
      .join(", ");
    const values = entries.map(([column, value]) =>
      column === "customFields" ? JSON.stringify(value) : value,
    );

    // `updatedAt` is supplied explicitly. Prisma's `@updatedAt` is applied
    // by the *client*, not by a column default, so a raw insert that leaves
    // it out violates the column's NOT NULL — which is what a real
    // insert through this shim did until a test caught it. `createdAt`
    // needs no such help: it has a real `DEFAULT now()` in the migration.
    await db.$executeRawUnsafe(
      `INSERT INTO "Item" (${columns}, "updatedAt") VALUES (${placeholders}, now())`,
      ...values,
    );
    return args.data;
  };

  const executeRawUnsafe = (sql: string, ...values: unknown[]) =>
    db.$executeRawUnsafe(sql, ...values);
  const queryRawUnsafe = <T>(sql: string, ...values: unknown[]) =>
    db.$queryRawUnsafe<T>(sql, ...values);

  return {
    item: { findFirst, create },
    // `ensureArea` reads back through `$queryRaw`; nothing else touches the
    // `area` delegate, so it is deliberately absent rather than stubbed
    // with something that would compile and then be wrong at run time.
    area: {},
    $executeRaw: taggedTemplate(executeRawUnsafe),
    $queryRaw: taggedTemplate(queryRawUnsafe),
    $executeRawUnsafe: executeRawUnsafe,
    $queryRawUnsafe: queryRawUnsafe,
  } as unknown as BackfillClient;
}
