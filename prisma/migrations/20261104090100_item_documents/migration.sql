-- Documents: keyed JSON entries attached to an item, loaded on demand.
--
-- ── Reversibility ───────────────────────────────────────────────────────
--
-- Purely additive and fully reversible: it creates two new tables and
-- touches NO existing table, column, constraint or row. `DROP TABLE
-- "ItemDocEntry"; DROP TABLE "ItemDoc";` is a complete reversal, and the
-- only data it discards is documents, which exist only because these tables
-- do. That is what makes it safe to apply to a live store ahead of the code
-- that reads it.
--
-- ── Why two tables ──────────────────────────────────────────────────────
--
-- `ItemDoc` is the document: one row per (item, name), carrying the
-- document's revision. `ItemDocEntry` is a keyed entry inside it.
--
-- The revision is a counter for the whole document that only goes up. It
-- cannot be derived from the entries (`max("rev")`), because deleting the
-- newest key would make it go backwards and a caller holding a stale number
-- would be told nothing had changed. The `ItemDoc` row is also what a patch
-- locks, so two patches to one document are applied one after the other.
--
-- ── Why the entries are rows and not one JSON column ────────────────────
--
-- The writers are parallel sessions that each own a small part of the
-- whole. One value per document makes every write a read-modify-write of
-- everything; one row per key lets a write name just the keys it changes.
-- The composite primary key (itemId, doc, key) is also the only index the
-- reads need: every read starts from an item, or from a parent's children,
-- and then a document name.
--
-- `ON DELETE CASCADE` all the way down: a document is a property of its
-- item and has no meaning once the item is gone.

CREATE TABLE "ItemDoc" (
    "itemId" TEXT NOT NULL,
    "doc" TEXT NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ItemDoc_pkey" PRIMARY KEY ("itemId","doc")
);

CREATE TABLE "ItemDocEntry" (
    "itemId" TEXT NOT NULL,
    "doc" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "rev" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,

    CONSTRAINT "ItemDocEntry_pkey" PRIMARY KEY ("itemId","doc","key")
);

-- AddForeignKey
ALTER TABLE "ItemDoc" ADD CONSTRAINT "ItemDoc_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemDocEntry" ADD CONSTRAINT "ItemDocEntry_itemId_doc_fkey" FOREIGN KEY ("itemId", "doc") REFERENCES "ItemDoc"("itemId", "doc") ON DELETE CASCADE ON UPDATE CASCADE;
