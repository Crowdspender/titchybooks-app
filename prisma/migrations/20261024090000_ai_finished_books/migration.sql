-- AI finished-book lifecycle.
--
-- Additive only: existing jobs keep their history (attempts stay claim
-- telemetry), historical print-only submissions keep working without a
-- reading PDF, and published templates keep serving manual flows even when
-- they are not AI-ready.

-- Dual render artifacts and their manifest (checksums / profile identity).
ALTER TABLE "Submission" ADD COLUMN "readingPdfS3Key" TEXT;
ALTER TABLE "Submission" ADD COLUMN "artifactManifest" JSONB;

-- AI template readiness plus the frozen manifest captured at publication.
ALTER TABLE "Submission" ADD COLUMN "aiReady" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Submission" ADD COLUMN "aiManifest" JSONB;

-- Frozen template scenes pinned to an AI book at compose time.
ALTER TABLE "Submission" ADD COLUMN "pinnedTemplate" JSONB;

ALTER TABLE "RenderJob" ADD COLUMN "readingPdfS3Key" TEXT;
ALTER TABLE "RenderJob" ADD COLUMN "artifactManifest" JSONB;

-- Failure budget is separate from claim telemetry; repairs have their own
-- budget, and every text job carries a hard lifetime deadline.
ALTER TABLE "AiBookJob" ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiBookJob" ADD COLUMN "repairCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiBookJob" ADD COLUMN "maxRepairs" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "AiBookJob" ADD COLUMN "deadlineAt" TIMESTAMP(3);

-- Request idempotency: one job per (user, request key).
ALTER TABLE "AiBookJob" ADD COLUMN "requestKey" TEXT;
ALTER TABLE "AiBookJob" ADD COLUMN "payloadDigest" TEXT;

-- Existing rows have no request key (NULL), which Postgres permits repeatedly.
CREATE UNIQUE INDEX "AiBookJob_userId_requestKey_key" ON "AiBookJob"("userId", "requestKey");
