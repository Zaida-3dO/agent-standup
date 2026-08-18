-- Indexes for the board's search, its origin filter and its sort keys —
-- MILESTONES.md #75.
--
-- ── Why a trigram index, and not a B-tree ───────────────────────────────
--
-- The board's `search` is `ILIKE '%term%'` over `title` and `body`. That
-- pattern is UNANCHORED, so no ordinary B-tree can serve it: a B-tree can
-- only skip ahead when it knows the leading characters, and a leading `%`
-- says the match may begin anywhere. Postgres therefore has one plan
-- available — read every row and compare — and the cost of the search box is
-- linear in the size of the store, on every keystroke that survives the
-- debounce, across four columns at once.
--
-- `pg_trgm` fixes exactly that shape. It decomposes each value into its
-- three-character substrings and indexes those, so an unanchored `ILIKE`
-- becomes a lookup of the pattern's own trigrams followed by a recheck on
-- the far smaller candidate set. `gin_trgm_ops` is the operator class that
-- teaches GIN to answer `LIKE`/`ILIKE` this way.
--
-- ── What this is NOT ────────────────────────────────────────────────────
--
-- This makes substring search fast. It does not make it *ranked*: there is
-- still no relevance ordering, no stemming and no phrase handling, and a
-- result set comes back in whatever sort the caller asked for. Ranked search
-- is its own row and wants a `tsvector` column with its own GIN index and a
-- `ts_rank` ordering — a different index answering a different question, not
-- a tuning of this one. The distinction is written down here because a
-- reader finding a GIN index on `body` could reasonably assume full-text
-- search already exists.
--
-- The extension itself is NOT in the datamodel — `schema.prisma` can declare
-- an index that USES `gin_trgm_ops` but has no way to say the operator class
-- must exist first, so the `CREATE EXTENSION` has to live here and only here.
-- `IF NOT EXISTS` because an installation may already have it.
--
-- ── Cost ────────────────────────────────────────────────────────────────
--
-- A trigram index is larger and slower to update than a B-tree, and `body`
-- runs to kilobytes. That is the right trade here: items are read far more
-- often than they are written, and the write path is one row at a time from
-- an agent, never a bulk load.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Item_title_trgm_idx" ON "Item" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Item_body_trgm_idx" ON "Item" USING GIN ("body" gin_trgm_ops);

-- The `actor` filter — an equality check on `originPersonId`, which had no
-- index of its own. `area` and `repo` already carry one for exactly the same
-- reason (SCHEMA.md §1: "(repo) is there because listing filters on it
-- exactly as it filters on area"), and origin is now a third axis a reader
-- can narrow the whole board by.
CREATE INDEX "Item_originPersonId_idx" ON "Item" ("originPersonId");

-- The sort keys' composite indexes, each including `id` because `id` is the
-- tie-break every board page orders by and every keyset cursor compares on.
-- A single-column index on the sort key alone would serve the ORDER BY but
-- not the cursor's row comparison, which is the query that actually runs on
-- every page after the first.
--
-- `createdAt` gets no entry here: the existing `Item_state_priority_idx` and
-- the primary key already cover the default ordering, and the board's
-- pre-existing pages were served acceptably without one.
CREATE INDEX "Item_updatedAt_id_idx" ON "Item" ("updatedAt", "id");
CREATE INDEX "Item_title_id_idx" ON "Item" ("title", "id");
