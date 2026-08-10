-- CreateEnum
CREATE TYPE "ItemKind" AS ENUM ('project', 'task', 'subtask');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('P0', 'P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "OriginType" AS ENUM ('person', 'source', 'auto');

-- CreateEnum
CREATE TYPE "DriveMode" AS ENUM ('autonomous', 'supervised', 'manual');

-- CreateEnum
CREATE TYPE "MergeAuthority" AS ENUM ('pre_approved', 'needs_approval', 'agent_judgement');

-- CreateEnum
CREATE TYPE "BlockedOnType" AS ENUM ('person', 'external_process', 'time');

-- CreateEnum
CREATE TYPE "Facet" AS ENUM ('reasoning', 'breadth', 'precision', 'autonomy', 'visual', 'writing');

-- CreateEnum
CREATE TYPE "ItemState" AS ENUM ('someday', 'on_deck', 'planning', 'plan_review', 'executing', 'in_review', 'paused', 'blocked', 'merged', 'research_done', 'wont_do', 'cancelled');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('orchestrator', 'builder', 'reviewer', 'visual_reviewer', 'scout', 'custom');

-- CreateEnum
CREATE TYPE "HolderType" AS ENUM ('person', 'agent');

-- CreateEnum
CREATE TYPE "Liveness" AS ENUM ('running', 'stalled', 'dead', 'superseded');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('person', 'agent', 'system');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('field_change', 'state_change', 'claim', 'release', 'takeover', 'review_requested', 'review', 'merge', 'dispatch', 'dispatch_claimed', 'checkpoint', 'nudge', 'escalation', 'note');

-- CreateEnum
CREATE TYPE "ArtifactKind" AS ENUM ('plan', 'plan_review', 'code_review', 'visual_review', 'test_run', 'commit', 'screenshot', 'other');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('approved', 'changes_required', 'na');

-- CreateEnum
CREATE TYPE "RunOutcome" AS ENUM ('completed', 'stalled', 'superseded', 'failed');

-- CreateEnum
CREATE TYPE "SelectionReason" AS ENUM ('recommended', 'exploration', 'override', 'pinned');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('subscription', 'metered');

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "parentId" TEXT,
    "kind" "ItemKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "state" "ItemState" NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'P2',
    "originType" "OriginType" NOT NULL,
    "originPersonId" TEXT,
    "area" TEXT NOT NULL,
    "repo" TEXT,
    "branch" TEXT,
    "needsVisualReview" BOOLEAN NOT NULL DEFAULT false,
    "driveMode" "DriveMode" NOT NULL DEFAULT 'autonomous',
    "mergeAuthority" "MergeAuthority" NOT NULL,
    "blockedReason" TEXT,
    "blockedOnType" "BlockedOnType",
    "blockedOnPersonId" TEXT,
    "unblockAt" TIMESTAMP(3),
    "pauseReason" TEXT,
    "resumeCondition" TEXT,
    "resumeAttempts" INTEGER NOT NULL DEFAULT 0,
    "difficulty" JSONB,
    "sourceRef" TEXT,
    "notify" JSONB,
    "estimatedCost" DECIMAL(65,30),
    "customFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "roleCustom" TEXT,
    "holderType" "HolderType" NOT NULL,
    "holderId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "parentSessionId" TEXT,
    "rootSessionId" TEXT NOT NULL,
    "machine" TEXT NOT NULL,
    "pid" INTEGER,
    "branch" TEXT,
    "worktree" TEXT,
    "liveness" "Liveness" NOT NULL DEFAULT 'running',
    "supersededBy" TEXT,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActive" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "model" TEXT,
    "effort" TEXT,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" BIGSERIAL NOT NULL,
    "itemId" TEXT,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "sessionId" TEXT,
    "assignmentId" TEXT,
    "type" "EventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "body" TEXT,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventSeen" (
    "eventId" BIGINT NOT NULL,
    "personId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventSeen_pkey" PRIMARY KEY ("eventId","personId")
);

-- CreateTable
CREATE TABLE "Summary" (
    "itemId" TEXT NOT NULL,
    "shipped" JSONB NOT NULL,
    "notDone" JSONB NOT NULL,
    "userFacing" BOOLEAN NOT NULL,
    "whatToTest" JSONB,
    "howVerified" TEXT,
    "watchFor" JSONB NOT NULL,
    "finalState" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Summary_pkey" PRIMARY KEY ("itemId")
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "kind" "ArtifactKind" NOT NULL,
    "verdict" "Verdict",
    "reviewRound" INTEGER NOT NULL DEFAULT 1,
    "commitSha" TEXT,
    "body" TEXT,
    "ref" TEXT,
    "browserSession" TEXT,
    "createdByType" "HolderType" NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatar" TEXT,
    "colour" TEXT,
    "notifyRules" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Authorization" (
    "id" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "scope" JSONB NOT NULL,
    "grantText" TEXT NOT NULL,

    CONSTRAINT "Authorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "name" TEXT NOT NULL,
    "roleHint" "Role",
    "persona" TEXT,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "itemId" TEXT,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tool" TEXT NOT NULL,
    "command" TEXT,
    "paths" TEXT[],
    "stateAt" "ItemState",
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "usage5h" DECIMAL(65,30),
    "usageWeekly" DECIMAL(65,30),

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "model" TEXT NOT NULL,
    "effort" TEXT NOT NULL,
    "selectionReason" "SelectionReason" NOT NULL,
    "recommendationStrength" DECIMAL(65,30),
    "inputTokens" BIGINT NOT NULL DEFAULT 0,
    "outputTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheWriteTokens" BIGINT NOT NULL DEFAULT 0,
    "cacheReadTokens" BIGINT NOT NULL DEFAULT 0,
    "cost" DECIMAL(65,30),
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "outcome" "RunOutcome",
    "reworkRequired" BOOLEAN NOT NULL DEFAULT false,
    "blockingFindings" INTEGER NOT NULL DEFAULT 0,
    "steeringInterventions" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunScore" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "facet" "Facet" NOT NULL,
    "agentScore" INTEGER,
    "userScore" INTEGER,
    "userScoredBy" TEXT,
    "userScoredAt" TIMESTAMP(3),

    CONSTRAINT "RunScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "planType" "PlanType" NOT NULL,
    "usage5h" DECIMAL(65,30),
    "usageWeekly" DECIMAL(65,30),
    "usageAt" TIMESTAMP(3),

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Machine" (
    "name" TEXT NOT NULL,
    "lastPollAt" TIMESTAMP(3),
    "liveSessions" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Machine_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "MachineAccount" (
    "machineName" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,

    CONSTRAINT "MachineAccount_pkey" PRIMARY KEY ("machineName","accountId")
);

-- CreateIndex
CREATE INDEX "Item_state_idx" ON "Item"("state");

-- CreateIndex
CREATE INDEX "Item_parentId_idx" ON "Item"("parentId");

-- CreateIndex
CREATE INDEX "Item_area_idx" ON "Item"("area");

-- CreateIndex
CREATE INDEX "Item_state_priority_idx" ON "Item"("state", "priority");

-- CreateIndex
CREATE INDEX "Item_sourceRef_idx" ON "Item"("sourceRef");

-- CreateIndex
CREATE INDEX "Assignment_sessionId_idx" ON "Assignment"("sessionId");

-- CreateIndex
CREATE INDEX "Assignment_itemId_role_idx" ON "Assignment"("itemId", "role");

-- CreateIndex
CREATE INDEX "Assignment_rootSessionId_idx" ON "Assignment"("rootSessionId");

-- CreateIndex
CREATE INDEX "Event_itemId_ts_idx" ON "Event"("itemId", "ts");

-- CreateIndex
CREATE INDEX "Event_type_ts_idx" ON "Event"("type", "ts");

-- CreateIndex
CREATE INDEX "Event_assignmentId_type_ts_idx" ON "Event"("assignmentId", "type", "ts");

-- CreateIndex
CREATE INDEX "Artifact_itemId_kind_reviewRound_idx" ON "Artifact"("itemId", "kind", "reviewRound");

-- CreateIndex
CREATE INDEX "ToolCall_sessionId_ts_idx" ON "ToolCall"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "ToolCall_itemId_ts_idx" ON "ToolCall"("itemId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "RunScore_runId_facet_key" ON "RunScore"("runId", "facet");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_originPersonId_fkey" FOREIGN KEY ("originPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_blockedOnPersonId_fkey" FOREIGN KEY ("blockedOnPersonId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSeen" ADD CONSTRAINT "EventSeen_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventSeen" ADD CONSTRAINT "EventSeen_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Summary" ADD CONSTRAINT "Summary_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Authorization" ADD CONSTRAINT "Authorization_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunScore" ADD CONSTRAINT "RunScore_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineAccount" ADD CONSTRAINT "MachineAccount_machineName_fkey" FOREIGN KEY ("machineName") REFERENCES "Machine"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MachineAccount" ADD CONSTRAINT "MachineAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
