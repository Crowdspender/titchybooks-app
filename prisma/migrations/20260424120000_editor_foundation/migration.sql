-- AlterTable
ALTER TABLE "Submission" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'LEGACY_UPLOAD';
ALTER TABLE "Submission" ADD COLUMN "title" TEXT;
ALTER TABLE "Submission" ADD COLUMN "previewS3Key" TEXT;
ALTER TABLE "Submission" ADD COLUMN "editorVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Submission" ADD COLUMN "submittedAt" DATETIME;

-- CreateTable
CREATE TABLE "SubmissionPage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "pageLabel" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "sceneJson" TEXT NOT NULL DEFAULT '{}',
    "previewS3Key" TEXT,
    "renderedPageS3Key" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SubmissionPage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "fileSize" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Asset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SubmissionPage_submissionId_idx" ON "SubmissionPage"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionPage_submissionId_pageLabel_key" ON "SubmissionPage"("submissionId", "pageLabel");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionPage_submissionId_order_key" ON "SubmissionPage"("submissionId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_s3Key_key" ON "Asset"("s3Key");

-- CreateIndex
CREATE INDEX "Asset_userId_idx" ON "Asset"("userId");
