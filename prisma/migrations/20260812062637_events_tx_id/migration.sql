-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "txId" BIGINT NOT NULL DEFAULT txid_current();

-- CreateIndex
CREATE INDEX "Event_txId_idx" ON "Event"("txId");
