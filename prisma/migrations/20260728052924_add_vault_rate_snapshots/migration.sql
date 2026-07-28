-- CreateTable
CREATE TABLE "VaultRateSnapshot" (
    "id" TEXT NOT NULL,
    "vault" TEXT NOT NULL,
    "rate" DOUBLE PRECISION NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultRateSnapshot_pkey" PRIMARY KEY ("id")
);
