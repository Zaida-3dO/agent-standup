-- A stored `depth` on `Item`, so the board can narrow by true tree level.
--
-- ── Why a column, and not `kind` ────────────────────────────────────────
--
-- Depth is already derived and stored — as `kind`. But `kindForDepth`
-- collapses every depth from 2 downwards into `subtask` (SCHEMA.md §1,
-- "kind is derived from depth"), so a level-2 subtask under a task and a
-- level-4 subtask four levels down are the SAME stored value. A reader
-- asking for "level 1 and 2 only" is asking a question the existing column
-- cannot answer, and no `WHERE` clause over `kind` can be made to answer it.
--
-- Nesting is unbounded. `items.max_depth` (SCHEMA.md §17.2) is a runaway
-- guard an installation configures, not a ceiling the schema encodes — so
-- this is an integer rather than three more enum members.
--
-- ── Why it is safe to store a derived value here ────────────────────────
--
-- The same argument `kind` already rests on: depth is a pure function of the
-- row's position in the tree, and exactly two code paths change that
-- position — a create (`insertItem`, which already computes the number it
-- passes to `kindForDepth`) and a reparent (`applyMove`, which already walks
-- the whole moved subtree re-deriving `kind` on every row). Both write
-- `depth` in the same statement they write `kind`, so the two cannot drift
-- apart without one of those two paths being wrong about both at once.
--
-- The alternative is a recursive CTE per row on every board read — on the
-- hottest read in the product, and one that already runs a recursive walk of
-- its own for the project column.
--
-- ── The backfill ────────────────────────────────────────────────────────
--
-- `DEFAULT 0` would silently type every existing row as a project, which is
-- the one wrong answer that looks like a real one: the level filter's own
-- default is "everything except level 0", so an unbackfilled store would
-- render an EMPTY board rather than an obviously broken one.
--
-- So every row is walked from its roots. The recursion starts at rows with
-- no parent (depth 0) and adds one per hop. A row whose `parentId` points at
-- a row that does not exist is not reachable from any root and so is not
-- produced by this CTE at all — it keeps the column default of 0. That is
-- deliberate: such a row IS a root as far as the tree can tell, because
-- there is nothing above it to count, and the same is what `ancestorDepthOf`
-- would return for it on the next write.
--
-- Written as one `UPDATE ... FROM` rather than a loop: the tree is small
-- enough to walk whole (projects number in the tens, items in the
-- thousands), and a set-based backfill is one statement that either applies
-- or does not.
ALTER TABLE "Item" ADD COLUMN "depth" INTEGER NOT NULL DEFAULT 0;

WITH RECURSIVE tree AS (
  SELECT "id", 0 AS "depth"
  FROM "Item"
  WHERE "parentId" IS NULL
  UNION ALL
  SELECT i."id", t."depth" + 1
  FROM "Item" i JOIN tree t ON i."parentId" = t."id"
)
UPDATE "Item" AS i
SET "depth" = t."depth"
FROM tree AS t
WHERE i."id" = t."id" AND i."depth" IS DISTINCT FROM t."depth";

-- The board's level filter is an equality-shaped narrowing (`depth = ANY(…)`
-- or its negation) applied on EVERY board read — "everything except
-- projects" is the default rather than something a reader opts into — so it
-- is indexed for the same reason `area` and `repo` are (SCHEMA.md §1).
CREATE INDEX "Item_depth_idx" ON "Item" ("depth");
