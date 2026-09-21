ALTER TABLE "User"
  ADD COLUMN "audience" TEXT NOT NULL DEFAULT 'creator',
  ADD COLUMN "businessName" TEXT,
  ADD COLUMN "businessType" TEXT,
  ADD COLUMN "companySize" TEXT;

CREATE TABLE "RenderJob" (
  "id" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "errorMessage" TEXT,
  "pdfS3Key" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RenderJob_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RenderJob_submissionId_idx" ON "RenderJob"("submissionId");
CREATE INDEX "RenderJob_status_idx" ON "RenderJob"("status");
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_submissionId_fkey"
  FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
