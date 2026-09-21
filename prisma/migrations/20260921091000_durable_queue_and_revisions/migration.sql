ALTER TABLE "Submission" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SubmissionPage" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RenderJob"
  ADD COLUMN "inputSnapshot" JSONB,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "claimToken" TEXT;
CREATE INDEX "RenderJob_status_nextAttemptAt_idx" ON "RenderJob"("status", "nextAttemptAt");
CREATE INDEX "RenderJob_status_leaseExpiresAt_idx" ON "RenderJob"("status", "leaseExpiresAt");
