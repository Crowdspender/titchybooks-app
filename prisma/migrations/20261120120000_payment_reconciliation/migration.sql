BEGIN;

-- Additive: no historical payment/FX/consent inference and no provider-schema writes.
CREATE TYPE "OrderPaymentState" AS ENUM ('UNPAID', 'PROCESSING', 'PAID', 'MANUAL_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED', 'DISPUTE_LOST', 'REVIEW', 'FAILED');
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('PREPARED', 'AMBIGUOUS', 'OPEN', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'REVIEW');
CREATE TYPE "PaymentEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'REVIEW', 'UNMATCHED', 'IGNORED', 'FAILED');

ALTER TABLE "Order"
  ADD COLUMN "paymentState" "OrderPaymentState",
  ADD COLUMN "paymentSummary" JSONB,
  ADD COLUMN "paymentHold" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "paymentRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD CONSTRAINT "Order_payment_revision_nonnegative" CHECK ("paymentRevision" >= 0);

CREATE TABLE "PaymentAttempt" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "expectedMinorAmount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "livemode" BOOLEAN NOT NULL,
  "providerAccountId" TEXT,
  "providerRequest" JSONB NOT NULL,
  "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'PREPARED',
  "sessionId" TEXT,
  "paymentIntentId" TEXT,
  "requestStartedAt" TIMESTAMP(3),
  "providerSnapshot" JSONB,
  "failureCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentAttempt_charge_valid" CHECK (
    "expectedMinorAmount" BETWEEN 1 AND 99999999 AND "currency" IN ('HUF', 'EUR', 'GBP') AND
    ("currency" <> 'HUF' OR "expectedMinorAmount" % 100 = 0)),
  CONSTRAINT "PaymentAttempt_sequence_positive" CHECK ("sequence" > 0)
);
CREATE UNIQUE INDEX "PaymentAttempt_idempotencyKey_key" ON "PaymentAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "PaymentAttempt_sessionId_key" ON "PaymentAttempt"("sessionId");
CREATE UNIQUE INDEX "PaymentAttempt_paymentIntentId_key" ON "PaymentAttempt"("paymentIntentId");
CREATE UNIQUE INDEX "PaymentAttempt_orderId_sequence_key" ON "PaymentAttempt"("orderId", "sequence");
CREATE INDEX "PaymentAttempt_orderId_status_idx" ON "PaymentAttempt"("orderId", "status");
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PaymentEvent" (
  "id" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "orderId" TEXT,
  "attemptId" TEXT,
  "providerAccountId" TEXT,
  "livemode" BOOLEAN,
  "objectId" TEXT,
  "providerCreatedAt" TIMESTAMP(3),
  "data" JSONB NOT NULL,
  "dataDigest" TEXT NOT NULL,
  "status" "PaymentEventStatus" NOT NULL DEFAULT 'RECEIVED',
  "outcome" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentEvent_source_valid" CHECK ("source" IN ('SIGNED_WEBHOOK', 'ADMIN_RECONCILIATION', 'ADMIN_REVIEW'))
);
CREATE UNIQUE INDEX "PaymentEvent_providerEventId_key" ON "PaymentEvent"("providerEventId");
CREATE INDEX "PaymentEvent_orderId_createdAt_idx" ON "PaymentEvent"("orderId", "createdAt");
CREATE INDEX "PaymentEvent_attemptId_idx" ON "PaymentEvent"("attemptId");
CREATE INDEX "PaymentEvent_status_createdAt_idx" ON "PaymentEvent"("status", "createdAt");
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Issued financial terms and published provider identities cannot be reassigned.
CREATE FUNCTION "protect_payment_attempt"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."orderId", NEW."sequence", NEW."idempotencyKey", NEW."expectedMinorAmount", NEW."currency", NEW."livemode", NEW."providerRequest", NEW."createdAt")
     IS DISTINCT FROM ROW(OLD."orderId", OLD."sequence", OLD."idempotencyKey", OLD."expectedMinorAmount", OLD."currency", OLD."livemode", OLD."providerRequest", OLD."createdAt") OR
     (OLD."providerAccountId" IS NOT NULL AND NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId") OR
     (OLD."sessionId" IS NOT NULL AND NEW."sessionId" IS DISTINCT FROM OLD."sessionId") OR
     (OLD."paymentIntentId" IS NOT NULL AND NEW."paymentIntentId" IS DISTINCT FROM OLD."paymentIntentId") OR
     (OLD."requestStartedAt" IS NOT NULL AND NEW."requestStartedAt" IS DISTINCT FROM OLD."requestStartedAt") THEN
    RAISE EXCEPTION 'Issued payment attempt is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "PaymentAttempt_protect_issuance" BEFORE UPDATE ON "PaymentAttempt"
  FOR EACH ROW EXECUTE FUNCTION "protect_payment_attempt"();

-- A held unstarted order cannot bypass the application guard via another writer.
-- Fulfilled history and physical Vault copies are not canceled or erased here.
CREATE FUNCTION "protect_payment_fulfillment"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."paymentHold" AND OLD."status" IN ('PENDING_PAYMENT', 'PAID', 'CANCELLED') AND
     NEW."status" IN ('IN_PRODUCTION', 'SHIPPED', 'DELIVERED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Payment review is required before fulfillment';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Order_payment_fulfillment_hold" BEFORE UPDATE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION "protect_payment_fulfillment"();

COMMIT;
