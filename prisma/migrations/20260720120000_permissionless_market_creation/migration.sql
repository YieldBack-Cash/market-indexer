/*
  Warnings:

  - Added the required column `creator` to the `Market` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "creator" TEXT NOT NULL,
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "currentApy" BIGINT,
ADD COLUMN     "apyMin" BIGINT,
ADD COLUMN     "apyMax" BIGINT,
ADD COLUMN     "feeApy" BIGINT;

-- CreateIndex
CREATE INDEX "Market_creator_idx" ON "Market"("creator");
