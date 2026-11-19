BEGIN;

-- Additive only: existing prices, IDs, payment/history and provider schemas are untouched.
ALTER TABLE "Order"
  ADD COLUMN "quoteSnapshot" JSONB,
  ADD COLUMN "expectedMinorAmount" INTEGER,
  ADD COLUMN "fxRate" DECIMAL(24,18),
  ADD COLUMN "quoteAcceptedAt" TIMESTAMP(3),
  ADD COLUMN "requestKey" TEXT,
  ADD COLUMN "requestDigest" TEXT;

CREATE UNIQUE INDEX "Order_userId_requestKey_key" ON "Order"("userId", "requestKey");

ALTER TABLE "Order" ADD CONSTRAINT "Order_accepted_quote_complete" CHECK (
  ("requestKey" IS NULL AND "requestDigest" IS NULL) OR
  ("requestKey" IS NOT NULL AND "requestDigest" IS NOT NULL AND
   "quoteSnapshot" IS NOT NULL AND "expectedMinorAmount" IS NOT NULL AND
   "fxRate" IS NOT NULL AND "quoteAcceptedAt" IS NOT NULL)
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_charge_range" CHECK (
  "expectedMinorAmount" IS NULL OR
  ("expectedMinorAmount" BETWEEN 1 AND 99999999 AND "currency" IN ('HUF', 'EUR', 'GBP') AND
   ("currency" <> 'HUF' OR "expectedMinorAmount" % 100 = 0))
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_fx_range" CHECK ("fxRate" IS NULL OR "fxRate" > 0);

-- A proved legacy amount may be filled once; acceptance/FX are never fabricated.
CREATE FUNCTION "protect_order_quote"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."expectedMinorAmount" IS NOT NULL AND ROW(
    NEW."userId", NEW."submissionId", NEW."quantity", NEW."zone", NEW."weightGrams", NEW."shippingBand",
    NEW."vaultAddOn", NEW."vaultFeeHuf", NEW."unitPriceHuf", NEW."printCostHuf", NEW."handlingCostHuf",
    NEW."shippingCostHuf", NEW."discountHuf", NEW."totalHuf", NEW."currency", NEW."pricingConfigVersion",
    NEW."quoteSnapshot", NEW."expectedMinorAmount", NEW."fxRate", NEW."quoteAcceptedAt", NEW."requestKey", NEW."requestDigest",
    NEW."recipientName", NEW."line1", NEW."line2", NEW."city", NEW."postalCode", NEW."countryCode", NEW."phone"
  ) IS DISTINCT FROM ROW(
    OLD."userId", OLD."submissionId", OLD."quantity", OLD."zone", OLD."weightGrams", OLD."shippingBand",
    OLD."vaultAddOn", OLD."vaultFeeHuf", OLD."unitPriceHuf", OLD."printCostHuf", OLD."handlingCostHuf",
    OLD."shippingCostHuf", OLD."discountHuf", OLD."totalHuf", OLD."currency", OLD."pricingConfigVersion",
    OLD."quoteSnapshot", OLD."expectedMinorAmount", OLD."fxRate", OLD."quoteAcceptedAt", OLD."requestKey", OLD."requestDigest",
    OLD."recipientName", OLD."line1", OLD."line2", OLD."city", OLD."postalCode", OLD."countryCode", OLD."phone"
  ) THEN
    RAISE EXCEPTION 'Accepted order quote is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Order_protect_quote" BEFORE UPDATE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION "protect_order_quote"();

COMMIT;
