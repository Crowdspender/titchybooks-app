import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db } from '../fixtures/database';

const migration = readFileSync('prisma/migrations/20261118120000_atomic_order_settlement/migration.sql', 'utf8');
const statements = migration.match(/BEGIN;|LOCK TABLE[^;]+;|DO \$\$[\s\S]*?END \$\$;|ALTER TABLE[^;]+;|CREATE UNIQUE INDEX[^;]+;|COMMIT;/g)!;
async function apply(tx: Prisma.TransactionClient) {
  // Exercise the exact migration statements in the caller's transaction. Temp
  // tables shadow public tables; nothing touches application or provider schemas.
  expect(statements).toHaveLength(6);
  expect(statements[0]).toBe('BEGIN;');
  expect(statements[5]).toBe('COMMIT;');
  for (const sql of statements.slice(1, -1)) await tx.$executeRawUnsafe(sql);
}
async function legacyTables(tx: Prisma.TransactionClient) {
  await tx.$executeRawUnsafe('CREATE TEMP TABLE "Order" ("id" TEXT PRIMARY KEY, "paidAt" TIMESTAMP, "terms" TEXT) ON COMMIT DROP');
  await tx.$executeRawUnsafe('CREATE TEMP TABLE "VaultEntry" ("id" TEXT PRIMARY KEY, "orderId" TEXT, "publicConsent" BOOLEAN, "title" TEXT) ON COMMIT DROP');
  await tx.$executeRawUnsafe(`INSERT INTO "Order" VALUES ('original-order', '2026-01-02 03:04:05', 'original terms')`);
  await tx.$executeRawUnsafe(`INSERT INTO "VaultEntry" VALUES ('original-vault', 'original-order', true, 'Original Émilie')`);
}

describe('additive settlement migration safety', () => {
  it('preserves existing IDs, paidAt, terms, consent, and unknown manual evidence', async () => {
    await db.$transaction(async tx => {
      await legacyTables(tx);
      const beforeOrder = await tx.$queryRawUnsafe('SELECT * FROM "Order"');
      const beforeVault = await tx.$queryRawUnsafe('SELECT * FROM "VaultEntry"');
      await apply(tx);
      expect(await tx.$queryRawUnsafe('SELECT "id", "paidAt", "terms" FROM "Order"')).toEqual(beforeOrder);
      expect(await tx.$queryRawUnsafe('SELECT * FROM "VaultEntry"')).toEqual(beforeVault);
      expect(await tx.$queryRawUnsafe('SELECT "manualSettlement" FROM "Order"')).toEqual([{ manualSettlement: null }]);
      await tx.$executeRawUnsafe('SAVEPOINT duplicate_write');
      await expect(tx.$executeRawUnsafe(`INSERT INTO "VaultEntry" VALUES ('second-vault', 'original-order', false, 'duplicate')`)).rejects.toThrow();
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT duplicate_write');
      expect(await tx.$queryRawUnsafe('SELECT * FROM "VaultEntry"')).toEqual(beforeVault);
    });
  });

  it('stops at duplicate preflight without deleting either history row or adding columns', async () => {
    await db.$transaction(async tx => {
      await legacyTables(tx);
      await tx.$executeRawUnsafe(`INSERT INTO "VaultEntry" VALUES ('second-vault', 'original-order', false, 'Second retained title')`);
      const before = await tx.$queryRawUnsafe('SELECT * FROM "VaultEntry" ORDER BY "id"');
      await tx.$executeRawUnsafe('SAVEPOINT migration_attempt');
      await expect(apply(tx)).rejects.toThrow('Duplicate VaultEntry.orderId links exist');
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT migration_attempt');
      expect(await tx.$queryRawUnsafe('SELECT * FROM "VaultEntry" ORDER BY "id"')).toEqual(before);
      const columns = await tx.$queryRawUnsafe<Array<{ attname: string }>>(`SELECT attname FROM pg_attribute WHERE attrelid = 'pg_temp."Order"'::regclass AND attnum > 0 AND NOT attisdropped`);
      expect(columns.map(row => row.attname)).not.toContain('manualSettlement');
    });
  });
});
