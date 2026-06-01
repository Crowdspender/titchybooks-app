# SQLite to PostgreSQL Migration

## Overview
Switch the Prisma datasource from `sqlite` to `postgresql`, reset existing SQLite migration history, generate a fresh initial PostgreSQL migration from the current schema, and update environment files for a hosted PostgreSQL database (Neon/Vercel Postgres/Supabase).

## Task 1: Update Prisma schema provider
**File:** `prisma/schema.prisma`
- Change `datasource db` provider from `"sqlite"` to `"postgresql"`

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

## Task 2: Update environment configuration
**File:** `.env`
- Replace `DATABASE_URL="file:./dev.db"` with a PostgreSQL connection string placeholder:
```env
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require"
```

**File:** `.env.example`
- Add or update the `DATABASE_URL` template to show PostgreSQL format

## Task 3: Remove SQLite migration history and lock
- Delete all existing migration folders under `prisma/migrations/` (they contain SQLite-specific SQL that won't work on PostgreSQL)
- Delete `prisma/migrations/migration_lock.toml` (it locks to `provider = "sqlite"`)

## Task 4: Generate fresh PostgreSQL migration
- Run `npx prisma migrate dev --name init` to:
  1. Create a new `prisma/migrations/` directory with the correct PostgreSQL migration SQL
  2. Generate a new `migration_lock.toml` with `provider = "postgresql"`
  3. Apply the schema to the new PostgreSQL database

## Task 5: Update seed script if needed
- Review `prisma/seed.ts` to ensure all SQL/Prisma operations are compatible with PostgreSQL (no SQLite-specific defaults or syntax)

## Task 6: Verify build script
**File:** `package.json`
- Confirm `"build": "prisma generate && next build"` is still present (already fixed)
- Ensure `prisma generate` runs before `next build` in Vercel

## Task 7: Vercel environment variables
- Add `DATABASE_URL` as a Vercel project environment variable (production + preview)
- The value should be the full PostgreSQL connection string from the chosen provider (Neon, Vercel Postgres, or Supabase)

## Post-migration checklist
- Test local dev with the new `DATABASE_URL` pointing to the hosted database
- Verify all pages and API routes load without Prisma errors
- Confirm Vercel deployment succeeds with `prisma generate && next build`
- Delete `dev.db` and `prisma/dev.db` from the repository to prevent confusion