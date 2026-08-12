-- The two partial unique indexes on "Assignment" (SCHEMA.md §2).
--
-- Hand-written, and they have to be: `@@unique` in Prisma's schema language
-- has no WHERE clause, so a partial index cannot be declared in
-- schema.prisma and therefore cannot be generated into a migration. These
-- are the constraints §2 specifies, transcribed directly.
--
-- Why hand-writing them costs nothing here. `prisma migrate diff` — what
-- `npm run db:check-drift` runs — compares the migration history against
-- the *datamodel*, and a partial index has no datamodel representation to
-- compare against. It is not that the diff tolerates these; it is that the
-- diff cannot see them at all, in either direction. So the drift check
-- reports no difference, and no exception, allowlist or suppression was
-- needed to get that result.
--
-- The same blindness is why `tests/claims.test.ts` reads `pg_indexes` and
-- asserts both definitions, predicates included. Nothing else in this
-- repository would notice if a WHERE clause were dropped or a UNIQUE
-- removed here: the drift check would stay green while "one LIVE
-- orchestrator" quietly became "one orchestrator ever", or stopped being
-- enforced at all.

-- One live orchestrator per item. Released rows are excluded, so an item
-- can change hands: `previous_sessions` are kept, not deleted (§2).
CREATE UNIQUE INDEX "Assignment_one_live_orchestrator_per_item"
  ON "Assignment" ("itemId")
  WHERE "role" = 'orchestrator' AND "releasedAt" IS NULL;

-- One live row per session per item. Keyed on both columns, not on
-- "itemId" alone: several sessions work one item at once (§2, "narrower
-- than it first looks"), and one session may hold rows on several items.
CREATE UNIQUE INDEX "Assignment_one_live_row_per_session_per_item"
  ON "Assignment" ("itemId", "sessionId")
  WHERE "releasedAt" IS NULL;
