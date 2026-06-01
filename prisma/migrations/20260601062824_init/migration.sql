-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'LEGACY_UPLOAD',
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pdfS3Key" TEXT,
    "previewS3Key" TEXT,
    "rejectionReason" TEXT,
    "editorVersion" INTEGER NOT NULL DEFAULT 1,
    "submittedAt" TIMESTAMP(3),
    "templateId" TEXT,
    "templateVersion" INTEGER,
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionImage" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "pageLabel" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionPage" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "pageLabel" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "sceneJson" TEXT NOT NULL DEFAULT '{}',
    "previewS3Key" TEXT,
    "renderedPageS3Key" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubmissionPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "fileSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "zone" TEXT NOT NULL,
    "weightGrams" INTEGER NOT NULL,
    "shippingBand" INTEGER NOT NULL,
    "unitPriceHuf" INTEGER NOT NULL,
    "printCostHuf" INTEGER NOT NULL,
    "handlingCostHuf" INTEGER NOT NULL DEFAULT 0,
    "shippingCostHuf" INTEGER NOT NULL,
    "discountHuf" INTEGER NOT NULL DEFAULT 0,
    "totalHuf" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'HUF',
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "pricingConfigVersion" INTEGER NOT NULL,
    "recipientName" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "phone" TEXT,
    "fulfilmentHub" TEXT,
    "couponCode" TEXT,
    "parentBatchId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TemplateElement" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "pageLabel" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "elementJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TemplateElement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingConfig" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "version" INTEGER NOT NULL DEFAULT 1,
    "weightPerBookGrams" INTEGER NOT NULL DEFAULT 6,
    "handlingFixedHuf" INTEGER NOT NULL DEFAULT 0,
    "handlingPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "enabledZones" TEXT NOT NULL,
    "weightBands" TEXT NOT NULL,
    "shippingTable" TEXT NOT NULL,
    "priceTiers" TEXT NOT NULL,
    "currencyRates" TEXT NOT NULL DEFAULT '{"HUF":1,"EUR":0.0026,"GBP":0.0022}',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "PricingConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Submission_userId_idx" ON "Submission"("userId");

-- CreateIndex
CREATE INDEX "Submission_isTemplate_idx" ON "Submission"("isTemplate");

-- CreateIndex
CREATE INDEX "Submission_templateId_idx" ON "Submission"("templateId");

-- CreateIndex
CREATE INDEX "SubmissionImage_submissionId_idx" ON "SubmissionImage"("submissionId");

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

-- CreateIndex
CREATE INDEX "Order_userId_idx" ON "Order"("userId");

-- CreateIndex
CREATE INDEX "Order_submissionId_idx" ON "Order"("submissionId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "TemplateElement_templateId_idx" ON "TemplateElement"("templateId");

-- CreateIndex
CREATE INDEX "TemplateElement_templateId_pageLabel_idx" ON "TemplateElement"("templateId", "pageLabel");

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionImage" ADD CONSTRAINT "SubmissionImage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionPage" ADD CONSTRAINT "SubmissionPage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TemplateElement" ADD CONSTRAINT "TemplateElement_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
