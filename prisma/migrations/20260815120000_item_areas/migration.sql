-- An item may sit in several areas (SCHEMA.md §23.1).
--
-- Additive and loss-free: `Item.area` is untouched and stays the primary
-- area, so every existing row, index, filter and foreign key keeps working
-- exactly as it did. The new table is seeded from that column, so after this
-- migration every item's area set is `{its existing area}` — the same
-- information, now able to hold more than one.

CREATE TABLE "ItemArea" (
    "itemId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    CONSTRAINT "ItemArea_pkey" PRIMARY KEY ("itemId","areaId")
);

CREATE INDEX "ItemArea_areaId_idx" ON "ItemArea"("areaId");

ALTER TABLE "ItemArea" ADD CONSTRAINT "ItemArea_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ItemArea" ADD CONSTRAINT "ItemArea_areaId_fkey"
  FOREIGN KEY ("areaId") REFERENCES "Area"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed from the existing primary area. `ON CONFLICT DO NOTHING` so a re-run
-- is a no-op rather than an error that leaves the migration half-applied.
INSERT INTO "ItemArea" ("itemId", "areaId")
SELECT "id", "area" FROM "Item"
ON CONFLICT DO NOTHING;
