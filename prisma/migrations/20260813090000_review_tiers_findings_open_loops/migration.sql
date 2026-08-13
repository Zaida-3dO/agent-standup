-- Review tiering, structured findings, and open-loop events.
-- Additive throughout: three new enum labels on "Verdict", two on
-- "EventType", two new nullable columns on "Artifact". No existing column,
-- constraint or row is altered, so this migration has nothing to lose and
-- nothing to back-fill.
--
-- `ADD VALUE IF NOT EXISTS` rather than a bare `ADD VALUE`: re-running a
-- migration is not supposed to happen, but a bare `ADD VALUE` on a label
-- that already exists is an error, and an error here would leave the
-- migration half-applied. Postgres 12+ permits `ALTER TYPE ... ADD VALUE`
-- inside a transaction block (which is how Prisma runs this file) as long
-- as the new label is not USED in the same transaction — nothing below
-- writes one of these values, so that holds.

-- Verdict: the tiered review vocabulary (SCHEMA.md §6a).
ALTER TYPE "Verdict" ADD VALUE IF NOT EXISTS 'lgtm';
ALTER TYPE "Verdict" ADD VALUE IF NOT EXISTS 'lgtm_with_nits';
ALTER TYPE "Verdict" ADD VALUE IF NOT EXISTS 'lgtm_with_followups';

-- EventType: an open loop, and its close (SCHEMA.md §3a).
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'open_loop';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'open_loop_closed';

-- Artifact: a review's findings, each with its own severity, and the
-- follow-up item a `lgtm_with_followups` verdict defers them into.
ALTER TABLE "Artifact" ADD COLUMN "findings" JSONB;
ALTER TABLE "Artifact" ADD COLUMN "followUpItemId" TEXT;

ALTER TABLE "Artifact"
  ADD CONSTRAINT "Artifact_followUpItemId_fkey"
  FOREIGN KEY ("followUpItemId") REFERENCES "Item"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Artifact_followUpItemId_idx" ON "Artifact"("followUpItemId");

-- A GIN index on the findings document. This is storage-side only — no
-- query in the application reads it yet — but it is the difference between
-- "severity is recorded" and "severity can be asked about", and adding it
-- later would mean a second migration over a table that will by then hold
-- every historical review.
CREATE INDEX "Artifact_findings_idx" ON "Artifact" USING GIN ("findings" jsonb_path_ops);
