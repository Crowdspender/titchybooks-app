-- AlterTable: add currencyRates JSON column to PricingConfig.
-- SQLite's ALTER TABLE ADD COLUMN requires a constant default, so we store
-- the HUF-as-base reference rates as a JSON string. Existing rows get the
-- default; savePricingConfig() thereafter updates the value via upsert.
ALTER TABLE "PricingConfig"
ADD COLUMN "currencyRates" TEXT NOT NULL DEFAULT '{"HUF":1,"EUR":0.0026,"GBP":0.0022}';
