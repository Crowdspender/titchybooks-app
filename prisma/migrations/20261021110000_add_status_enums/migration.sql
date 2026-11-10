-- Replace free-form String state columns with native Postgres enums. Values
-- were audited before the conversion (no out-of-set rows), and every write in
-- the application already used one of these literals.
--
-- Defaults must be dropped before the type change: Postgres cannot cast a text
-- default implicitly. They are restored afterwards as enum literals.

CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
CREATE TYPE "SubmissionMode" AS ENUM ('LEGACY_UPLOAD', 'EDITOR', 'TEMPLATE');
CREATE TYPE "SubmissionStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PROCESSING', 'FAILED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED', 'CANCELLED');
CREATE TYPE "VaultEntryStatus" AS ENUM ('STORED', 'WITHDRAWN', 'CANCELLED');
CREATE TYPE "AiBookJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "AiBookStage" AS ENUM ('CONCEPT', 'CONTENT', 'COMPOSE', 'RENDER', 'QA');
CREATE TYPE "RenderJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

ALTER TABLE "User"
  ALTER COLUMN "role" DROP DEFAULT,
  ALTER COLUMN "role" TYPE "UserRole" USING ("role"::text::"UserRole"),
  ALTER COLUMN "role" SET DEFAULT 'USER';

ALTER TABLE "Submission"
  ALTER COLUMN "mode" DROP DEFAULT,
  ALTER COLUMN "mode" TYPE "SubmissionMode" USING ("mode"::text::"SubmissionMode"),
  ALTER COLUMN "mode" SET DEFAULT 'LEGACY_UPLOAD',
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "SubmissionStatus" USING ("status"::text::"SubmissionStatus"),
  ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TABLE "Order"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "OrderStatus" USING ("status"::text::"OrderStatus"),
  ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT';

ALTER TABLE "VaultEntry"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "VaultEntryStatus" USING ("status"::text::"VaultEntryStatus"),
  ALTER COLUMN "status" SET DEFAULT 'STORED';

ALTER TABLE "AiBookJob"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "AiBookJobStatus" USING ("status"::text::"AiBookJobStatus"),
  ALTER COLUMN "status" SET DEFAULT 'QUEUED',
  ALTER COLUMN "stage" DROP DEFAULT,
  ALTER COLUMN "stage" TYPE "AiBookStage" USING ("stage"::text::"AiBookStage"),
  ALTER COLUMN "stage" SET DEFAULT 'CONCEPT';

ALTER TABLE "RenderJob"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "RenderJobStatus" USING ("status"::text::"RenderJobStatus"),
  ALTER COLUMN "status" SET DEFAULT 'QUEUED';
