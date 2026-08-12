-- Crew naming — the pre-item hold (SCHEMA.md §9, MILESTONES.md #34).
--
-- `Assignment` cannot represent "this session has a crew name but hasn't
-- claimed an item yet" — `Assignment.itemId` is required. These two columns
-- are that narrower, earlier hold: set together when a name is handed out
-- or assigned, cleared together when it is released. See
-- src/lib/agent-names.ts for the atomic hand-out/assign/release statements
-- that read and write them.
ALTER TABLE "Agent" ADD COLUMN     "heldBySessionId" TEXT;
ALTER TABLE "Agent" ADD COLUMN     "heldAt" TIMESTAMPTZ(3);
