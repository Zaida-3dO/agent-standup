-- The session registry (SCHEMA.md §21).
--
-- Additive throughout: two new enum types and one new table. No existing
-- type, column, constraint or row is altered, so this migration has nothing
-- to back-fill and nothing to lose.
--
-- The one reference out of the new table is a nullable foreign key to
-- "Person", so an installation with no people rows can still register every
-- session it has.

-- How a session registered. Five values because the version rule turns on
-- the binding, and they are the same names the conformance drivers use.
-- Underscored rather than hyphenated: a Postgres enum label may contain a
-- hyphen, but Prisma's generated TypeScript member names may not, so the
-- wire spelling (`cli-direct`) and the storage spelling (`cli_direct`) are
-- translated at the service boundary rather than the database carrying an
-- identifier the client cannot name.
CREATE TYPE "SessionTransport" AS ENUM ('cli_direct', 'cli_http', 'mcp_stdio', 'mcp_http', 'http');

-- Which hook a session gets. Two values, not five: the transport is the
-- signal, the variant is the answer, and several transports give the same
-- answer.
CREATE TYPE "HookVariant" AS ENUM ('cli', 'http');

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "machine" TEXT NOT NULL,
    "transport" "SessionTransport" NOT NULL,
    "hookVariant" "HookVariant",
    "hookVariantOverridden" BOOLEAN NOT NULL DEFAULT false,
    "hookVersion" INTEGER,
    "client" TEXT,
    "personId" TEXT,
    "registeredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- The liveness sweep and every "what has been running lately" read order by
-- this column, and both would otherwise scan a table that grows once per
-- session forever.
CREATE INDEX "Session_lastSeenAt_idx" ON "Session"("lastSeenAt");

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
