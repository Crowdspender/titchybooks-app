-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "qaSampled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AiBookJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "templateId" TEXT,
    "submissionId" TEXT,
    "renderJobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "stage" TEXT NOT NULL DEFAULT 'CONCEPT',
    "stageOutput" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseExpiresAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiBookJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiBookJob_userId_idx" ON "AiBookJob"("userId");

-- CreateIndex
CREATE INDEX "AiBookJob_submissionId_idx" ON "AiBookJob"("submissionId");

-- CreateIndex
CREATE INDEX "AiBookJob_status_nextAttemptAt_idx" ON "AiBookJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AiBookJob_status_leaseExpiresAt_idx" ON "AiBookJob"("status", "leaseExpiresAt");

-- AddForeignKey
ALTER TABLE "AiBookJob" ADD CONSTRAINT "AiBookJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiBookJob" ADD CONSTRAINT "AiBookJob_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
