-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PricingConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "version" INTEGER NOT NULL DEFAULT 1,
    "weightPerBookGrams" INTEGER NOT NULL DEFAULT 6,
    "handlingFixedHuf" INTEGER NOT NULL DEFAULT 0,
    "handlingPercent" REAL NOT NULL DEFAULT 0,
    "enabledZones" TEXT NOT NULL,
    "weightBands" TEXT NOT NULL,
    "shippingTable" TEXT NOT NULL,
    "priceTiers" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedByUserId" TEXT
);

-- CreateIndex
CREATE INDEX "Order_userId_idx" ON "Order"("userId");

-- CreateIndex
CREATE INDEX "Order_submissionId_idx" ON "Order"("submissionId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");
