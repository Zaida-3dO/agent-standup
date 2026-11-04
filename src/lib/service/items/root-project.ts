// The project an item ultimately belongs to — the one fact a flat list of
// items (an inbox, a board column, a feed of events) cannot show on its own.
//
// A task says nothing about which project it is part of, and a subtask may
// sit several levels below one, so a row that wants to read "Recipe box ·
// Import the file" needs the top of the chain. Three reads want it
// (`get_needs_you`, `get_board`, slim `get_events`), and each would be free
// to walk the tree slightly differently, so there is one definition.
//
// ── One statement for the whole page, not one per row ───────────────────
//
// The obvious implementation — read the rows, then ask each one for its
// parent, and that one for its parent — is N+1 against a response that by
// construction contains every row on screen. This follows the shape
// `SUBTASK_ROLLUP_SQL` established, but walks the other way: the recursion is
// seeded with **every** id on the page at once, then follows `parentId` *up*,
// carrying the starting id through each hop so a row three levels deep is
// still reported against itself.
//
// ── What comes back ─────────────────────────────────────────────────────
//
// For each starting id, the topmost ancestor whose kind is `project`:
//
//   - a task or subtask      → its project, however deep it sits;
//   - a project itself       → no entry (`hops > 0` excludes the starting
//                              row), so the caller reports `null` — a
//                              project is not "in" a project;
//   - an orphan (no parent, or a chain that ends on a non-project)
//                            → no entry, so `null`.
//
// "Absent from the map" is therefore the one way all of those say `null`; a
// caller never has to tell them apart.
//
// Archived ancestors are walked through rather than stopped at. An archived
// row is the installation saying it should never have existed, but a live
// task that still hangs beneath one still belongs to the project at the top
// of the chain, and refusing to look past the archived link would report it
// as an orphan.
//
// The hop cap is a backstop, not a rule: `parentId` is a tree by
// construction, and the cap only exists so a corrupted cycle ends a request
// with a wrong answer instead of never ending it.
import type { TransactionHandle } from "../context";

/** The project an item belongs to, as every read that carries it names it. */
export interface RootProject {
  readonly id: string;
  readonly title: string;
}

/** A row the statement below returns: the id asked about, and its project. */
export interface RawRootProjectRow {
  startId: string;
  projectId: string;
  projectTitle: string;
}

/** The longest chain walked before giving up — see the module header. */
const MAX_HOPS = 1000;

/**
 * `$1` is the array of starting ids. The CTE is named `root_project_walk` so
 * a test can count this statement specifically in a query log, the same
 * reason `rollup_subtree` is named apart from `subtree`.
 *
 * `DISTINCT ON` with `hops DESC` picks the topmost project when a chain
 * somehow holds more than one, so the answer is the root and not merely the
 * first project reached.
 */
export const ROOT_PROJECT_SQL = `WITH RECURSIVE root_project_walk AS (
     SELECT i."id" AS "startId", i."id" AS "nodeId", i."parentId" AS "parentId",
            i."kind" AS "kind", i."title" AS "title", 0 AS "hops"
     FROM "Item" i
     WHERE i."id" = ANY($1::text[])
     UNION ALL
     SELECT w."startId", p."id", p."parentId", p."kind", p."title", w."hops" + 1
     FROM root_project_walk w JOIN "Item" p ON p."id" = w."parentId"
     WHERE w."hops" < ${MAX_HOPS}
   )
   SELECT DISTINCT ON (w."startId") w."startId" AS "startId",
          w."nodeId" AS "projectId", w."title" AS "projectTitle"
   FROM root_project_walk w
   WHERE w."kind" = 'project'::"ItemKind" AND w."hops" > 0
   ORDER BY w."startId", w."hops" DESC`;

/**
 * The root project of every id in `ids`, in one statement.
 *
 * Returns a map holding an entry only for ids that **have** a root project;
 * read it with `map.get(id) ?? null`. Ids are de-duplicated, and an empty
 * list issues no query at all.
 */
export async function rootProjectsFor(
  db: Pick<TransactionHandle, "$queryRawUnsafe">,
  ids: readonly string[],
): Promise<Map<string, RootProject>> {
  const unique = [...new Set(ids)];
  const byId = new Map<string, RootProject>();
  if (unique.length === 0) return byId;
  const rows = await db.$queryRawUnsafe<RawRootProjectRow[]>(ROOT_PROJECT_SQL, unique);
  for (const row of rows) {
    byId.set(row.startId, { id: row.projectId, title: row.projectTitle });
  }
  return byId;
}
