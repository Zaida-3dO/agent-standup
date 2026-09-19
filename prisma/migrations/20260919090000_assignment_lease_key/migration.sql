-- The lease key on an assignment: one field carrying the crew root and the
-- holder's identity together, so a caller states who is claiming once
-- rather than in four separately-fallible fields (SCHEMA.md §2,
-- `src/lib/lease-key.ts`).
--
-- ── Reversibility ───────────────────────────────────────────────────────
--
-- Additive and fully reversible. It adds ONE nullable column to
-- `Assignment` and one index on it. It creates no table, drops nothing,
-- changes no existing column's type or nullability, adds no constraint to
-- any existing column, and — this is the part worth being explicit about —
-- **it does not modify a single pre-existing value.** The backfill writes
-- only into the column this migration itself creates, which was NULL in
-- every row a moment earlier.
--
-- `ALTER TABLE "Assignment" DROP COLUMN "leaseKey";` is therefore a
-- complete reversal, and the only data it discards is data derived from
-- four columns that are still sitting there. Nothing is lost that cannot be
-- recomputed by re-running the statement below. That matters because this
-- is the one migration in this change that touches stored rows, and it is
-- the reason it can be applied to a live store ahead of the code that
-- reads it.
--
-- ── Why the column is NULLABLE and stays that way ───────────────────────
--
-- A `NOT NULL` column would have to be added with a default or in three
-- steps, and both cost more than they buy here. More importantly, nullable
-- is *honest*: a row written by an older build during a rolling deploy
-- genuinely has no key, and a column that cannot say so would need a
-- sentinel value that every reader then has to know about. Application code
-- treats an absent key as "derive it from the four columns", which is
-- exactly what the backfill does and is always possible, because
-- `rootSessionId`, `sessionId`, `holderType` and `holderId` are all
-- `NOT NULL` on this table already.
--
-- So there is no state in which a missing key loses information. That is
-- what makes the whole change safe to land before anything writes keys.

ALTER TABLE "Assignment" ADD COLUMN "leaseKey" TEXT;

-- ── The backfill ────────────────────────────────────────────────────────
--
-- `encodeLeaseKey` (src/lib/lease-key.ts), expressed in SQL. The key is a
-- pure derivation of four columns:
--
--     lk1.<base64url(root NUL session NUL holderType NUL holderId)>.<sha256 prefix>
--
-- Doing it in SQL rather than in a script is deliberate. A script would
-- need a database connection, a deploy step of its own, and a decision
-- about what happens when it is interrupted halfway; this runs inside the
-- migration's own transaction, so it either completes or leaves the column
-- as it found it.
--
-- **Re-runnable, in the two senses that matter.**
--
--   1. `WHERE "leaseKey" IS NULL` means a second run rewrites nothing. It
--      is a no-op against an already-backfilled table, so re-applying it by
--      hand after a partial restore costs one index scan and changes no row.
--   2. The expression is a PURE FUNCTION of columns that never change once
--      written, so even a run WITHOUT that guard would compute byte-for-byte
--      the same key it computed the first time. The guard is there to make
--      the work zero, not to make the answer stable — the answer was
--      already stable. That is the property that lets this be re-run safely
--      in a recovery, where the guard alone would not be enough to trust.
--
-- **Why `translate` and `rtrim`.** Postgres `encode(..., 'base64')` emits
-- STANDARD base64 — `+`, `/`, and `=` padding. Node's `base64url`, which
-- `decodeLeaseKey` reads, uses `-` and `_` and no padding. Converting here
-- rather than loosening the decoder keeps one encoding in the system:
-- the decoder stays strict, and a key from either producer is the same
-- string. `encode` also wraps its output with newlines every 76 characters
-- for MIME, which `replace` strips — a wrapped key would otherwise decode
-- fine in Postgres and fail in Node, which is the worst kind of difference.
--
-- **Why `sha256` needs no extension.** It has been a built-in since
-- Postgres 11; only the older `digest()` requires `pgcrypto`. This tree
-- runs Postgres 17 (docker-compose.yml, and the CI service container), so
-- adding an extension here would be a dependency taken on for nothing.
--
-- `chr(0)` is the field separator, matching `FIELD_SEPARATOR` in
-- `lease-key.ts`. Nothing on this table can legitimately contain it, and
-- the encoder refuses a field that does.
UPDATE "Assignment"
SET "leaseKey" =
  'lk1.'
  || rtrim(
       translate(
         replace(
           encode(
             convert_to(
               "rootSessionId" || chr(0) || "sessionId" || chr(0)
                 || "holderType"::text || chr(0) || "holderId",
               'UTF8'
             ),
             'base64'
           ),
           E'\n', ''
         ),
         '+/', '-_'
       ),
       '='
     )
  || '.'
  || substr(
       encode(
         sha256(
           convert_to(
             "rootSessionId" || chr(0) || "sessionId" || chr(0)
               || "holderType"::text || chr(0) || "holderId",
             'UTF8'
           )
         ),
         'hex'
       ),
       1, 8
     )
WHERE "leaseKey" IS NULL;

-- Lookup by key — "which assignment is this lease", asked with a key pasted
-- from a dispatch brief or a refusal message. The same anchored-equality
-- argument the `ItemLink_url_idx` comment makes: a B-tree serves it, and it
-- is the question an operator actually asks about a key they are holding.
--
-- Declared in `schema.prisma` as well as here. An index Prisma CAN model
-- must be in the datamodel or `prisma migrate diff` emits a `DROP INDEX`
-- for it and the drift check fails — `20260917090000_item_links` records
-- that rule and why "the migration has it" is not sufficient.
CREATE INDEX "Assignment_leaseKey_idx" ON "Assignment"("leaseKey");
