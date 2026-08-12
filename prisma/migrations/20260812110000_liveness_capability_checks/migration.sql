-- CreateEnum
CREATE TYPE "CapabilityCheckResult" AS ENUM ('exists', 'missing', 'unverified');

-- CreateTable
CREATE TABLE "capability_checks" (
    "key" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "result" "CapabilityCheckResult" NOT NULL,
    "lastCheckedByType" "ActorType" NOT NULL,
    "lastCheckedById" TEXT,
    "lastCheckedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "capability_checks_pkey" PRIMARY KEY ("key")
);
