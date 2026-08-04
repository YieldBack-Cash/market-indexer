-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "creator" TEXT,
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currentApy" BIGINT,
ADD COLUMN     "apyMin" BIGINT,
ADD COLUMN     "apyMax" BIGINT,
ADD COLUMN     "feeApy" BIGINT;

-- CreateIndex
CREATE INDEX "Market_creator_idx" ON "Market"("creator");
