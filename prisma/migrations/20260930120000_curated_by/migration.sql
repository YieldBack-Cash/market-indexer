-- Who made each curation decision. The admin API now carries one credential
-- per curator and records the name here; the CLI records the operator's name.
-- Rows curated before this column existed keep NULL.

ALTER TABLE "Market" ADD COLUMN "curatedBy" TEXT;
ALTER TABLE "Vault" ADD COLUMN "curatedBy" TEXT;
ALTER TABLE "Protocol" ADD COLUMN "curatedBy" TEXT;
