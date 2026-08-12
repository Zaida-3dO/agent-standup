-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "budget_windows" JSONB;

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "source_globs" TEXT[];

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedByType" "ActorType" NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "settings_revision" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "revision" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "settings_revision_pkey" PRIMARY KEY ("id")
);

-- "settings_revision" holds exactly one row (SCHEMA.md §17.2). The primary
-- key alone only makes `id` unique; it does not stop a second row arriving
-- with id = 2, at which point "the revision" is a question with two answers
-- and every cached snapshot is comparing against whichever one it read.
-- Prisma's schema language cannot express a check constraint, so it is
-- written here and asserted by a test that tries to insert a second row.
ALTER TABLE "settings_revision"
    ADD CONSTRAINT "settings_revision_single_row" CHECK ("id" = 1);

-- The one row, seeded at revision 0 so a reader never has to treat "no row
-- yet" as a separate case from "nothing has changed yet". Resolution and
-- the cache both read a revision unconditionally; without this they would
-- each need a null branch that exists only on the very first boot.
INSERT INTO "settings_revision" ("id", "revision") VALUES (1, 0);
