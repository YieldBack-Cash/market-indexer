-- Split the five protocol_* columns off Vault into a Protocol row that vaults
-- point at. One protocol deploys a vault per asset, so the old shape meant
-- retyping (and drifting) the same five values on every new vault.

-- CreateTable
CREATE TABLE "Protocol" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "website" TEXT,
    "docsUrl" TEXT,
    "auditUrl" TEXT,
    "curatedAt" TIMESTAMP(3),
    "curationNote" TEXT,

    CONSTRAINT "Protocol_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Vault" ADD COLUMN "protocolId" TEXT;

-- Data migration. Every vault that named a protocol gets the row for it.
--
-- The slug is derived from protocolName, except that Blend is pinned to
-- `blendv2`: the vaults deployed so far lend into Blend v2, and v3 will want a
-- slug of its own rather than inheriting this one.
CREATE TEMP TABLE "_vault_protocol" AS
SELECT
    "address",
    CASE
        WHEN lower("protocolName") LIKE 'blend%' THEN 'blendv2'
        ELSE regexp_replace(lower("protocolName"), '[^a-z0-9]+', '', 'g')
    END AS "slug",
    "protocolName",
    "protocolLogoUrl",
    "protocolWebsite",
    "protocolDocsUrl",
    "protocolAuditUrl",
    "curatedAt"
FROM "Vault"
WHERE "protocolName" IS NOT NULL;

-- Refuse to guess. If two vaults that map to the same protocol disagree on any
-- of its fields, that is exactly the drift this migration exists to end —
-- reconcile the rows by hand, then re-run.
DO $$
DECLARE
    drifted TEXT;
BEGIN
    SELECT string_agg("slug", ', ') INTO drifted
    FROM (
        SELECT "slug"
        FROM "_vault_protocol"
        GROUP BY "slug"
        HAVING count(DISTINCT "protocolName") > 1
            OR count(DISTINCT coalesce("protocolLogoUrl", '')) > 1
            OR count(DISTINCT coalesce("protocolWebsite", '')) > 1
            OR count(DISTINCT coalesce("protocolDocsUrl", '')) > 1
            OR count(DISTINCT coalesce("protocolAuditUrl", '')) > 1
    ) d;

    IF drifted IS NOT NULL THEN
        RAISE EXCEPTION 'Vault protocol fields disagree for: %. Make the rows match before migrating.', drifted;
    END IF;
END $$;

INSERT INTO "Protocol" ("id", "updatedAt", "name", "logoUrl", "website", "docsUrl", "auditUrl", "curatedAt")
SELECT
    "slug",
    now(),
    min("protocolName"),
    min("protocolLogoUrl"),
    min("protocolWebsite"),
    min("protocolDocsUrl"),
    min("protocolAuditUrl"),
    max("curatedAt")
FROM "_vault_protocol"
GROUP BY "slug";

UPDATE "Vault" v
SET "protocolId" = vp."slug"
FROM "_vault_protocol" vp
WHERE v."address" = vp."address";

DROP TABLE "_vault_protocol";

-- AlterTable
ALTER TABLE "Vault"
    DROP COLUMN "protocolName",
    DROP COLUMN "protocolLogoUrl",
    DROP COLUMN "protocolWebsite",
    DROP COLUMN "protocolDocsUrl",
    DROP COLUMN "protocolAuditUrl";

-- CreateIndex
CREATE INDEX "Vault_protocolId_idx" ON "Vault"("protocolId");

-- AddForeignKey
ALTER TABLE "Vault" ADD CONSTRAINT "Vault_protocolId_fkey" FOREIGN KEY ("protocolId") REFERENCES "Protocol"("id") ON DELETE SET NULL ON UPDATE CASCADE;
