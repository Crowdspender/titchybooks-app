-- Preserve all history. Hold the write lock across preflight and index creation
-- so a concurrent legacy writer cannot introduce a duplicate between them.
BEGIN;
LOCK TABLE "VaultEntry" IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "VaultEntry" GROUP BY "orderId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate VaultEntry.orderId links exist. Stop for an approved preservation/remediation decision; no rows were removed.';
  END IF;
END $$;

ALTER TABLE "Order" ADD COLUMN "manualSettlement" JSONB;
CREATE UNIQUE INDEX "VaultEntry_orderId_key" ON "VaultEntry"("orderId");
COMMIT;
