-- An item's external pointers — the Slack thread, the ticket, the design doc
-- — as first-class rows rather than prose or an artifact wearing the wrong
-- kind.
--
-- ── Reversibility ───────────────────────────────────────────────────────
--
-- Purely additive and fully reversible: it creates one new table and its
-- indexes, and touches NO existing table, column, constraint or row. There
-- is no backfill, no `ALTER`, and no column whose type or nullability
-- changes, so every existing read, write, index and foreign key is left
-- exactly as this migration found it. `DROP TABLE "ItemLink";` is therefore
-- a complete reversal, and the only data it discards is links, which exist
-- only because this table does. That is worth stating plainly rather than
-- leaving a reviewer to derive it, because it is what makes this safe to
-- apply to a live store ahead of the code that reads it.
--
-- ── Why the primary key is all three columns ────────────────────────────
--
-- `(itemId, key, url)` makes recording the same link twice idempotent in the
-- DATABASE rather than in a write path that remembers to check first. That
-- distinction is not academic here: the artifact importer's own dedupe key
-- is documented as "purely the check-then-write this function performs, not
-- an index Postgres enforces", which leaves two concurrent writers able to
-- race past it. A primary key has no such gap, and it costs nothing extra —
-- the table needs a unique identity anyway, and this is the one it has.
--
-- `key` is part of the identity deliberately. The same URL under two labels
-- is two claims (one page can be both "the ticket" and "the escalation
-- thread"), and the same label against two URLs is likewise two links, which
-- is how an item carries three separate design docs.

CREATE TABLE "ItemLink" (
    "itemId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    CONSTRAINT "ItemLink_pkey" PRIMARY KEY ("itemId","key","url")
);

-- `ON DELETE CASCADE` matches `ItemArea`: a link is a property of its item
-- and has no meaning once the item is gone, so it should not need a second
-- statement to clean up — and `delete_item` does not know about this table.
ALTER TABLE "ItemLink" ADD CONSTRAINT "ItemLink_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Exact lookup by URL — "which item carries this link?", asked with a URL
-- pasted from a chat window. A B-tree serves that anchored equality far more
-- cheaply than the trigram index below, and this is the question a reader
-- asks most often about a link they already hold.
CREATE INDEX "ItemLink_url_idx" ON "ItemLink"("url");

-- ── The trigram indexes: what makes this feature worth building ─────────
--
-- The measured problem this whole change exists to fix: 141 of 141 artifact
-- rows carrying a ref have that ref appearing NOWHERE in their item's body,
-- while `search` and the board's search filter are `ILIKE` over
-- `Item.title|headline|body` only. So recording a pointer properly made it
-- LESS findable than leaving it in prose — an incentive pointing exactly the
-- wrong way, which would have trained callers straight back out of any typed
-- field we gave them.
--
-- `search` therefore reaches items through their links, with an unanchored
-- `ILIKE '%term%'` against both columns. That pattern cannot use a B-tree
-- for the reason the item search already documents: a leading `%` says the
-- match may begin anywhere, which leaves a sequential scan as the only plan.
-- `gin_trgm_ops` decomposes each value into three-character substrings so
-- the pattern becomes a lookup plus a recheck on a much smaller set.
--
-- Both columns are indexed because both are searched, and for different
-- questions: a caller pastes a URL fragment to find the item, or types a
-- label ("slack") to find every item that carries one.
--
-- `pg_trgm` is created here as well as in the migration that first needed
-- it. `IF NOT EXISTS` makes that a no-op on any database that already has
-- it, and repeating it is what keeps this migration's own prerequisites
-- stated rather than inherited by ordering — the extension is not in the
-- datamodel, so nothing else would notice if that ordering ever changed.
--
-- These indexes are ALSO declared in `schema.prisma`, unlike the partial
-- index on `Item.archivedAt` which lives only here. The distinction is what
-- the datamodel can express: a partial index (`WHERE ...`) genuinely cannot
-- be written there, but a GIN index with an operator class CAN
-- (`@@index([url(ops: raw("gin_trgm_ops"))], type: Gin, ...)`), and `Item`
-- already declares two that way. Leaving these out of the datamodel is
-- therefore real drift rather than an unavoidable exemption — `prisma
-- migrate diff` sees an index in the database with no counterpart in the
-- schema and emits `DROP INDEX` for each, which
-- `tests/partial-index-drift.test.ts` fails on by design. The generalisable
-- rule: "the migration has it" is not sufficient for an index Prisma can
-- model.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "ItemLink_url_trgm_idx" ON "ItemLink" USING GIN ("url" gin_trgm_ops);
CREATE INDEX "ItemLink_key_trgm_idx" ON "ItemLink" USING GIN ("key" gin_trgm_ops);
