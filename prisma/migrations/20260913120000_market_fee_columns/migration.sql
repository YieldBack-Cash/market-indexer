-- AlterTable
ALTER TABLE "Market" ADD COLUMN     "reserveFeeRate" BIGINT,
ADD COLUMN     "lpFeeApy" BIGINT,
ADD COLUMN     "lpFeeApyUpdatedAt" TIMESTAMP(3);
