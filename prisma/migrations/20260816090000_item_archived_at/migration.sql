-- An item can be withdrawn from circulation without leaving the database
-- (SCHEMA.md §1, §23.1's "archive, never delete"; MILESTONES.md #137).
--
-- Additive and loss-free: every existing row gets `NULL`, which is the
-- not-archived state, so nothing already stored changes meaning and every
-- read that has not yet learned about this column keeps returning what it
-- always did.
--
-- Nullable timestamp rather than a boolean, matching `Repo`, `Area` and
-- `Person`. "When" answers "whether" and a boolean does not answer "when",
-- so the narrower column would throw away the only fact that makes a
-- mistaken archive reviewable after the fact.
ALTER TABLE "Item" ADD COLUMN "archivedAt" TIMESTAMPTZ(3);

-- Why an archive needs a reason, stored beside the timestamp: the operation
-- refuses to proceed without one, and a reason kept only in the event log
-- would make "why is this row invisible" a question answerable solely by
-- walking history. The row states its own reason.
ALTER TABLE "Item" ADD COLUMN "archivedReason" TEXT;

-- The item this one was archived in favour of, when there is one. A
-- self-reference rather than free text because the overwhelmingly common
-- archive is a duplicate, and a duplicate has a survivor: recording it as a
-- pointer means a reader who arrives at the archived row by an old link can
-- be sent to the live one, which is the whole reason the row is kept rather
-- than deleted.
--
-- `ON DELETE SET NULL` is defensive rather than expected — nothing in the
-- product deletes an item, which is the point of this migration — but a
-- dangling pointer would be worse than a null one if a row ever does leave
-- by some other route.
ALTER TABLE "Item" ADD COLUMN "supersededById" TEXT;

ALTER TABLE "Item" ADD CONSTRAINT "Item_supersededById_fkey"
  FOREIGN KEY ("supersededById") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ordinary reads all filter on this column, and the overwhelming majority of
-- rows are not archived. A partial index over the archived rows is the one
-- that pays: it is small, and it serves the deliberate "show me what was
-- archived" read without adding write cost to the common path.
CREATE INDEX "Item_archivedAt_idx" ON "Item"("archivedAt") WHERE "archivedAt" IS NOT NULL;
