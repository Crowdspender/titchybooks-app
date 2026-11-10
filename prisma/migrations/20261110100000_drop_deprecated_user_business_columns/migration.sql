-- DESTRUCTIVE: drops the legacy business-registration columns added by
-- 20260921090000_repair_business_and_render_jobs. No application code has read
-- or written them since authentication was unified into a single signup flow,
-- but the stored values are unrecoverable once this runs.
--
-- Before applying to production, capture a Neon point-in-time timestamp and a
-- fresh logical dump (docs/operations-runbook.md, "Database backups and
-- restore"). There is deliberately no down migration: rolling back means
-- restoring a PITR branch, not re-adding empty columns.

-- AlterTable
ALTER TABLE "User" DROP COLUMN "audience",
DROP COLUMN "businessName",
DROP COLUMN "businessType",
DROP COLUMN "companySize";
