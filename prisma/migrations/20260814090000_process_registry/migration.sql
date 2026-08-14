-- The process registry (MILESTONES.md #45).
--
-- Additive: one new table, no existing column, constraint or row altered,
-- so this migration has nothing to back-fill and nothing to lose. An empty
-- registry is a valid state and is what every existing installation has the
-- moment this applies — the guard's behaviour on an empty registry is
-- therefore not an edge case, it is day one, and it is tested as such.

CREATE TABLE "registered_processes" (
  "id"             TEXT NOT NULL,
  "machine"        TEXT NOT NULL,
  "pid"            INTEGER NOT NULL,
  "executable"     TEXT NOT NULL,
  "sessionId"      TEXT NOT NULL,
  "root_session_id" TEXT NOT NULL,
  "description"    TEXT,
  "registeredAt"   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"        TIMESTAMPTZ(3),

  CONSTRAINT "registered_processes_pkey" PRIMARY KEY ("id")
);

-- The guard's own lookup: every live row for one (machine, pid) or one
-- (machine, executable). Both are read on the hot path — a kill guard runs
-- inside a tool call — so both are indexed rather than one.
CREATE INDEX "registered_processes_machine_pid_idx"
  ON "registered_processes"("machine", "pid");
CREATE INDEX "registered_processes_machine_executable_idx"
  ON "registered_processes"("machine", "executable");
CREATE INDEX "registered_processes_root_session_id_idx"
  ON "registered_processes"("root_session_id");

-- One LIVE registration per (machine, pid). A pid is unique per host while
-- it is running, so two live rows claiming the same one means two sessions
-- believe they own the same process and the ownership answer would depend
-- on row order. Partial, so the row kept after the process ends does not
-- block the pid being reused later — which operating systems do.
CREATE UNIQUE INDEX "registered_processes_live_machine_pid_key"
  ON "registered_processes"("machine", "pid")
  WHERE "endedAt" IS NULL;
