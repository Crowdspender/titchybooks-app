-- Add owner opt-in flag for the public /vault directory listing.
-- Defaults to false so existing entries stay private until their authors consent.
ALTER TABLE "VaultEntry" ADD COLUMN "publicConsent" BOOLEAN NOT NULL DEFAULT false;
