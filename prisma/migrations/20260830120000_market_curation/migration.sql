-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "listed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "curatedAt" TIMESTAMP(3),
ADD COLUMN     "curationNote" TEXT;

-- CreateIndex
CREATE INDEX "Market_listed_maturity_idx" ON "Market"("listed", "maturity");
