-- Runs, as telemetry cuts them (SCHEMA.md §11, MILESTONES.md #51) — plus the
-- indexes the per-item, per-session and per-stage rollups read (#53).
--
-- Additive throughout: no column is dropped, no type is narrowed, and the
-- one existing NOT NULL that is relaxed is relaxed in the direction that
-- accepts every row already stored.
--
-- ── Why `selectionReason` becomes nullable ──────────────────────────────
--
-- §11 describes it as "Why this model was used", with `override` — an agent
-- rejecting a soft-deny — named as the valuable value. Every one of the four
-- values is a fact about a *dispatch decision*: something chose this model,
-- for a reason it can state. A run cut from telemetry has no such decision
-- behind it. The hook reports which model served a call; it cannot report
-- why that model was picked, because nothing told it, and no amount of
-- inference at the ingest would recover it.
--
-- Left NOT NULL, the only way to record such a run is to invent a value for
-- it, and the invented value would be indistinguishable from a real one.
-- `recommended` is the tempting default and is the worst available answer:
-- the picker's report card (§12) compares how overridden and explored runs
-- fare against recommended ones, so filling this column with `recommended`
-- for every telemetry-cut run poisons the comparison group with runs nobody
-- recommended anything about. NULL says "no decision was recorded here",
-- which is both true and excludable from that comparison by a reader who
-- knows to.
--
-- ── Why `sessionId` is added ────────────────────────────────────────────
--
-- §11's key is `(assignment, model, effort)`, and an assignment does imply a
-- session. But #53 aggregates cost **per session**, and a session's work is
-- not confined to its assignments: a ghost session (§10 — "real work with no
-- minted task") holds none at all, and its runs would be unreachable from an
-- assignment join. Storing the session on the run makes the per-session
-- rollup one indexed read rather than a join that silently omits exactly the
-- work that was never minted.
--
-- ── Why `stateAt` is added ──────────────────────────────────────────────
--
-- #53 aggregates **per stage**. `ToolCall.stateAt` already denormalises the
-- item's state for the same reason (§10: "slicing cost by stage is the whole
-- reason this column exists"), and a run inherits it from the calls it rolls
-- up. Deriving it instead — by joining every run to its calls and taking a
-- mode — would make the per-stage rollup a scan of the highest-volume table
-- in the schema, which is the cost §11's existence as a rollup exists to
-- avoid. Nullable for the same reason §10's is: a ghost session has no item
-- and therefore no stage.

-- The run's own token counts are already `BIGINT` in the baseline, so a run
-- accumulating many `INTEGER` per-call counts cannot overflow.

ALTER TABLE "Run" ALTER COLUMN "selectionReason" DROP NOT NULL;

ALTER TABLE "Run" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "Run" ADD COLUMN "stateAt" "ItemState";

-- `assignmentId` and `itemId` stay NOT NULL: a run is "one agent's turn on
-- one item" (§11), and a ghost session's calls are recorded as `ToolCall`
-- rows without ever being rolled into a run. That is the honest reading of
-- the table's own definition — inventing a run for work that has no item
-- would require inventing an item id to point it at.

-- ── The indexes the rollups read ────────────────────────────────────────
--
-- The baseline created `Run` with a primary key and its two foreign keys and
-- no index at all, which is correct for a table nothing queried. #53 gives it
-- three query shapes, and each gets the index it reads:
--
--   * per item — every run for one item, newest first
--   * per session — every run for one session, newest first
--   * per stage — every run in one state
--
-- `startedAt` is the second column on the first two because a rollup is
-- almost always bounded by time as well as by owner ("this week's cost for
-- this item"), and an index on the owner alone leaves that bound to a filter
-- over every row the owner ever produced.
CREATE INDEX "Run_itemId_startedAt_idx" ON "Run"("itemId", "startedAt");
CREATE INDEX "Run_sessionId_startedAt_idx" ON "Run"("sessionId", "startedAt");
CREATE INDEX "Run_stateAt_idx" ON "Run"("stateAt");

-- The open run for an assignment is looked up on **every ingested batch**, so
-- it is the hottest read this feature adds. A partial index over open runs
-- only: a closed run is never a candidate, and excluding them keeps the index
-- proportional to the number of live assignments rather than to the number of
-- runs ever recorded.
CREATE INDEX "Run_assignmentId_open_idx" ON "Run"("assignmentId") WHERE "endedAt" IS NULL;
