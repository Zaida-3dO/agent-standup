-- Intervention firings and their scores — the evidence loop for the
-- catalogue (`docs/plans/INTERVENTIONS.md`).
--
-- ── What this closes ─────────────────────────────────────────────────────
--
-- The guard surface only ever grows. Every incident adds a catalogue entry
-- and nothing has ever removed one, because there has never been any record
-- of whether a given entry earned its cost. Entries have shipped that were
-- unsatisfiable by construction, and entries have shipped whose messages
-- named a remedy the same guard then refused; both were discovered by a
-- person hitting them, not by the system noticing.
--
-- These two tables record what fired and what it was worth, so that a
-- persistently unhelpful entry can be found in a query rather than in an
-- argument.
--
-- ── Two tables, not a score column ───────────────────────────────────────
--
-- The same split `Run`/`RunScore` already draws. A firing is a fact the
-- server observed on the hook path; a score is a judgement made later, by a
-- different actor, which may never arrive. A nullable column would collapse
-- "nobody has rated this" into "rated and cleared", and telling those apart
-- is the entire point.
--
-- Additive only. Two new tables, two new enums, no existing row or column
-- changes meaning, and no backfill: firings before this migration were
-- never recorded and are honestly absent rather than invented.

CREATE TYPE "InterventionOutcome" AS ENUM ('silent', 'nudged', 'blocked', 'overridden');

CREATE TYPE "InterventionRaterType" AS ENUM ('agent', 'person');

CREATE TABLE "intervention_events" (
    "id" BIGSERIAL NOT NULL,
    -- The catalogue entry, e.g. 'I10'. Deliberately NOT a foreign key: the
    -- catalogue is code-backed and designed to shed entries, and a retired
    -- entry's firings must outlive it — "this scored 1 forty times and we
    -- removed it" is the history this table exists to keep.
    "entry_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "root_session_id" TEXT,
    -- Unconstrained on purpose: many interventions fire on a session holding
    -- no claim, which is a normal firing rather than a defective row.
    "item_id" TEXT,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" "InterventionOutcome" NOT NULL,
    -- Resolved at firing time, stored rather than looked up: a score judges
    -- what actually happened, not the entry's current configuration.
    "level" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "tool" TEXT,
    "command" TEXT,
    "message" TEXT,
    "override_reason" TEXT,

    CONSTRAINT "intervention_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "intervention_events_entry_id_ts_idx" ON "intervention_events"("entry_id", "ts");
CREATE INDEX "intervention_events_session_id_ts_idx" ON "intervention_events"("session_id", "ts");
CREATE INDEX "intervention_events_root_session_id_ts_idx" ON "intervention_events"("root_session_id", "ts");

CREATE TABLE "intervention_scores" (
    "id" TEXT NOT NULL,
    "event_id" BIGINT NOT NULL,
    "rater_type" "InterventionRaterType" NOT NULL,
    "rater_id" TEXT,
    "score" INTEGER NOT NULL,
    "note" TEXT,
    "rated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intervention_scores_pkey" PRIMARY KEY ("id")
);

-- The scale is 1–5 and it is constrained here as well as in the parser.
-- An out-of-range score would silently skew every aggregate that reads this
-- table, and aggregates are the whole product of it — so the constraint sits
-- where no caller can route around it.
ALTER TABLE "intervention_scores"
    ADD CONSTRAINT "intervention_scores_score_range" CHECK ("score" BETWEEN 1 AND 5);

-- One score per rater per firing: a rater changing its mind updates its row
-- rather than adding a second, so no aggregate can be moved by one rater
-- voting twice.
CREATE UNIQUE INDEX "intervention_scores_event_id_rater_type_rater_id_key"
    ON "intervention_scores"("event_id", "rater_type", "rater_id");
CREATE INDEX "intervention_scores_event_id_idx" ON "intervention_scores"("event_id");

ALTER TABLE "intervention_scores"
    ADD CONSTRAINT "intervention_scores_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "intervention_events"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
