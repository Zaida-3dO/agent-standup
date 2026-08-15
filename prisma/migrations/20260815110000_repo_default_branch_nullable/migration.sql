-- `Repo.defaultBranch` becomes nullable (MILESTONES.md #124, DECISIONS.md
-- §13g). This column is consumed at PR-creation time; a `null` value there
-- makes a caller ask before assuming a base branch, while a wrong string
-- lets it proceed confidently against the wrong one. Every prior row was
-- written to a NOT NULL column, so nothing here needs backfilling — this
-- purely widens what the column is allowed to hold going forward.
--
-- Additive in the sense this project's migrations require: no row loses a
-- value it already had, and no existing NOT NULL string becomes invalid.
ALTER TABLE "Repo" ALTER COLUMN "defaultBranch" DROP NOT NULL;
