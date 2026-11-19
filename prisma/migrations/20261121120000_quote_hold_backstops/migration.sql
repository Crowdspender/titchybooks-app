BEGIN;

-- Tighten the landed backstops without rewriting history. A legacy row may keep
-- its proved amount and snapshot, but acceptance/FX facts always require the
-- replay key: the legacy branch can no longer carry fxRate/quoteAcceptedAt.
ALTER TABLE "Order" DROP CONSTRAINT "Order_accepted_quote_complete";
ALTER TABLE "Order" ADD CONSTRAINT "Order_accepted_quote_complete" CHECK (
  ("requestKey" IS NULL AND "requestDigest" IS NULL AND "fxRate" IS NULL AND "quoteAcceptedAt" IS NULL) OR
  ("requestKey" IS NOT NULL AND "requestDigest" IS NOT NULL AND
   "quoteSnapshot" IS NOT NULL AND "expectedMinorAmount" IS NOT NULL AND
   "fxRate" IS NOT NULL AND "quoteAcceptedAt" IS NOT NULL)
);

-- numeric NaN/Infinity sort above every finite value, so "fxRate > 0" alone
-- admits them and the quote trigger would then freeze them forever. Bound the
-- range exactly like calculateCharge (finite, > 0, <= 10); NULL stays legal.
ALTER TABLE "Order" DROP CONSTRAINT "Order_fx_range";
ALTER TABLE "Order" ADD CONSTRAINT "Order_fx_range" CHECK (
  "fxRate" IS NULL OR ("fxRate" > 0 AND "fxRate" <= 10)
);

-- The hold must be released before fulfillment starts: a single update that
-- clears paymentHold and advances status must not bypass the review gate.
-- The authorized release remains a separate transition; fulfilled history
-- (orders already IN_PRODUCTION or beyond) is still never blocked.
CREATE OR REPLACE FUNCTION "protect_payment_fulfillment"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."paymentHold" OR OLD."paymentHold") AND OLD."status" IN ('PENDING_PAYMENT', 'PAID', 'CANCELLED') AND
     NEW."status" IN ('IN_PRODUCTION', 'SHIPPED', 'DELIVERED') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'Payment review is required before fulfillment';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;