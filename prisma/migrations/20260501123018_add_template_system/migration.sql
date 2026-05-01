-- CreateTable
CREATE TABLE "TemplateElement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "pageLabel" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "elementJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TemplateElement_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Submission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'LEGACY_UPLOAD',
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pdfS3Key" TEXT,
    "previewS3Key" TEXT,
    "rejectionReason" TEXT,
    "editorVersion" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" DATETIME,
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Submission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Submission_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Submission" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Submission" ("createdAt", "editorVersion", "id", "mode", "pdfS3Key", "previewS3Key", "rejectionReason", "status", "submittedAt", "title", "updatedAt", "userId") SELECT "createdAt", "editorVersion", "id", "mode", "pdfS3Key", "previewS3Key", "rejectionReason", "status", "submittedAt", "title", "updatedAt", "userId" FROM "Submission";
DROP TABLE "Submission";
ALTER TABLE "new_Submission" RENAME TO "Submission";
CREATE INDEX "Submission_userId_idx" ON "Submission"("userId");
CREATE INDEX "Submission_isTemplate_idx" ON "Submission"("isTemplate");
CREATE INDEX "Submission_templateId_idx" ON "Submission"("templateId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TemplateElement_templateId_idx" ON "TemplateElement"("templateId");

-- CreateIndex
CREATE INDEX "TemplateElement_templateId_pageLabel_idx" ON "TemplateElement"("templateId", "pageLabel");
