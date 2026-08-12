-- Adds `Repo` and `Area` as installation-owned reference tables (SCHEMA.md
-- §23.1, DECISIONS.md §13g), wires `Item.area`/`Item.repo` to them as real
-- foreign keys, and adds the `Item.repo` index its filters already assumed
-- (SCHEMA.md §1: "`(repo)` is there because listing filters on it exactly
-- as it filters on `area`" — specified in the baseline but never created).
--
-- Additive only: the baseline migration is never edited. `Item.area` and
-- `Item.repo` keep their column types and nullability; only the foreign key
-- and (for repo) the index are new.
--
-- Backfill before constrain: `Item.area` is NOT NULL and `Item.repo` is
-- nullable free text today, so any row already written (seed data, manual
-- testing against a deployed database) can carry a value with no matching
-- row in the new reference tables. A NOT VALID-free foreign key added
-- straight onto that would fail to apply. Backfilling one row per distinct
-- existing value first — using the value itself as both `id` and
-- `display_name`, since that is the only information a bare text column
-- ever had — makes the constraint additive in the same sense the rest of
-- this migration is: it cannot break a database that already has rows, and
-- it adds nothing beyond what already existed as free text.

-- CreateTable
CREATE TABLE "Repo" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL,
    "host" TEXT,
    "needsVisualReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Area" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Area_pkey" PRIMARY KEY ("id")
);

-- Backfill: one Area per distinct existing Item.area value, so the
-- NOT NULL foreign key added below cannot fail against a database that
-- already has items. A no-op on a fresh/empty database.
INSERT INTO "Area" ("id", "displayName")
SELECT DISTINCT "area", "area" FROM "Item"
ON CONFLICT ("id") DO NOTHING;

-- Backfill: one Repo per distinct existing non-null Item.repo value, same
-- reason. "defaultBranch" has no prior value to backfill from — a bare
-- text column never carried one — so it defaults to "main" for backfilled
-- rows only; new repos created deliberately after this migration always
-- supply their own.
INSERT INTO "Repo" ("id", "displayName", "defaultBranch")
SELECT DISTINCT "repo", "repo", 'main' FROM "Item"
WHERE "repo" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;

-- CreateIndex
CREATE INDEX "Item_repo_idx" ON "Item"("repo");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_area_fkey" FOREIGN KEY ("area") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_repo_fkey" FOREIGN KEY ("repo") REFERENCES "Repo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
