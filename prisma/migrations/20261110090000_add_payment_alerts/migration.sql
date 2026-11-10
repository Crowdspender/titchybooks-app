-- CreateTable
CREATE TABLE "PaymentAlert" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAlert_dedupeKey_key" ON "PaymentAlert"("dedupeKey");

-- CreateIndex
CREATE INDEX "PaymentAlert_resolvedAt_lastSeenAt_idx" ON "PaymentAlert"("resolvedAt", "lastSeenAt");

-- CreateIndex
CREATE INDEX "PaymentAlert_orderId_idx" ON "PaymentAlert"("orderId");

-- AddForeignKey
ALTER TABLE "PaymentAlert" ADD CONSTRAINT "PaymentAlert_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

