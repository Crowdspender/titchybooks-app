-- Seed-managed starter templates.
--
-- Additive only: admin-authored templates keep working unchanged (their key is
-- NULL, which a unique index permits repeatedly). A key marks the three
-- complete text-first recipes so re-seeding can update its own content without
-- touching anything an admin wrote.

ALTER TABLE "Submission" ADD COLUMN "managedKey" TEXT;

CREATE UNIQUE INDEX "Submission_managedKey_key" ON "Submission"("managedKey");
