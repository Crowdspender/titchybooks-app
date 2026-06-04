-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "vaultAddOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vaultFeeHuf" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PricingConfig" ADD COLUMN     "vaultFeeHuf" INTEGER NOT NULL DEFAULT 2000;

-- CreateTable
CREATE TABLE "VaultEntry" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'STORED',
    "storedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VaultEntry_submissionId_idx" ON "VaultEntry"("submissionId");

-- CreateIndex
CREATE INDEX "VaultEntry_status_idx" ON "VaultEntry"("status");

-- AddForeignKey
ALTER TABLE "VaultEntry" ADD CONSTRAINT "VaultEntry_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VaultEntry" ADD CONSTRAINT "VaultEntry_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
