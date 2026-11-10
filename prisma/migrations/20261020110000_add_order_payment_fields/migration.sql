-- Stripe Checkout linkage on Order.
ALTER TABLE "Order" ADD COLUMN     "stripeSessionId" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Order_stripeSessionId_key" ON "Order"("stripeSessionId");
