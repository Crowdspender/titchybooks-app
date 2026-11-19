import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db, createUser, cleanupFixtures } from '../fixtures/database';
import { createOrderForUser } from '../fixtures/orders';
const migration = readFileSync('prisma/migrations/20261119120000_immutable_order_quotes/migration.sql', 'utf8');
const statements = migration.match(/BEGIN;|ALTER TABLE[^;]+;|CREATE UNIQUE INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$;|CREATE TRIGGER[^;]+;|COMMIT;/g)!;
const added = ['quoteSnapshot', 'expectedMinorAmount', 'fxRate', 'quoteAcceptedAt', 'requestKey', 'requestDigest'];
afterEach(async () => { await cleanupFixtures(); });
async function rehearsal(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    // The freeze loop makes dozens of savepoint round-trips; the default 5s
    // interactive-transaction budget can expire mid-loop under load.
    await db.$transaction(async tx => { await work(tx); throw new Error('ROLLBACK_QUOTE_REHEARSAL'); }, { timeout: 30000 });
  } catch (error) { if (!(error instanceof Error) || error.message !== 'ROLLBACK_QUOTE_REHEARSAL') throw error; }
}
async function legacyTable(tx: Prisma.TransactionClient) {
  // Real schema-shaped legacy rows, with all new columns removed before migration.
  await tx.$executeRawUnsafe('CREATE TEMP TABLE "Order" AS TABLE public."Order"');
  for (const column of added) await tx.$executeRawUnsafe(`ALTER TABLE "Order" DROP COLUMN "${column}"`);
}
async function apply(tx: Prisma.TransactionClient) {
  // Prove the parser does not silently omit any executable migration statement.
  expect(statements.join('').replace(/\s/g, '')).toBe(migration.replace(/^--.*$/gm, '').replace(/\s/g, ''));
  expect(statements).toHaveLength(9); expect(statements[0]).toBe('BEGIN;'); expect(statements.at(-1)).toBe('COMMIT;');
  for (const sql of statements.slice(1, -1)) {
    // Only namespace changes: exact constraint/trigger body runs on shadow temp tables.
    await tx.$executeRawUnsafe(sql.replaceAll('"protect_order_quote"', 'pg_temp."protect_order_quote"'));
  }
}
async function savepointReject(tx: Prisma.TransactionClient, operation: () => Promise<unknown>, message?: string) {
  await tx.$executeRawUnsafe('SAVEPOINT rejected_write');
  const assertion = expect(operation()).rejects;
  await (message ? assertion.toThrow(message) : assertion.toThrow());
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rejected_write');
}
describe('immutable quote additive migration preservation', () => {
  it('preserves legacy IDs/prices/payment/Vault/PDF/address history and unknown FX; leaves provider-schema probe unchanged', async () => {
    const user = await createUser();
    const { order, submission } = await createOrderForUser(user.id, { status: 'PAID', vaultAddOn: true });
    await db.order.update({ where: { id: order.id }, data: { paidAt: new Date('2020-01-02T03:04:05Z') } });
    const vault = await db.vaultEntry.create({ data: { orderId: order.id, submissionId: submission.id,
      title: 'Original Émilie', authorName: 'Synthetic Original', quantity: 2, publicConsent: true, status: 'STORED' } });
    const beforePublic = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    await rehearsal(async tx => {
      await legacyTable(tx);
      const before = await tx.$queryRawUnsafe('SELECT * FROM "Order" ORDER BY "id"');
      // Synthetic preservation probe, rolled back with the rehearsal, not provider certification.
      await tx.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS neon_auth');
      await tx.$executeRawUnsafe('CREATE TABLE neon_auth.batch4_quote_preservation_probe (id TEXT, value TEXT)');
      await tx.$executeRawUnsafe("INSERT INTO neon_auth.batch4_quote_preservation_probe VALUES ('synthetic-original', 'preserve')");
      const probe = await tx.$queryRawUnsafe('SELECT * FROM neon_auth.batch4_quote_preservation_probe');
      await apply(tx);
      const columns = Object.keys(beforePublic).filter(key => !added.includes(key)).map(key => `"${key}"`).join(',');
      expect(await tx.$queryRawUnsafe(`SELECT ${columns} FROM "Order" ORDER BY "id"`)).toEqual(before);
      expect(await tx.$queryRawUnsafe(`SELECT ${added.map(key => `"${key}"`).join(',')} FROM "Order"`)).toEqual([Object.fromEntries(added.map(key => [key, null]))]);
      expect(await tx.$queryRawUnsafe('SELECT * FROM neon_auth.batch4_quote_preservation_probe')).toEqual(probe);
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(beforePublic);
    expect(await db.vaultEntry.findUniqueOrThrow({ where: { id: vault.id } })).toEqual(vault);
    expect(await db.submission.findUniqueOrThrow({ where: { id: submission.id } })).toEqual(submission);
  });
  it('permits multiple legacy null keys and status/notes/session changes but freezes every accepted commercial field', async () => {
    const user = await createUser();
    const { order } = await createOrderForUser(user.id);
    await createOrderForUser(user.id);
    await rehearsal(async tx => {
      await legacyTable(tx); await apply(tx);
      await tx.$executeRaw`UPDATE "Order" SET "expectedMinorAmount" = 400000, "quoteSnapshot" = '{"origin":"LEGACY_STRIPE_SESSION"}' WHERE "id" = ${order.id}`;
      const frozen = (await tx.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT * FROM "Order" WHERE "expectedMinorAmount" IS NOT NULL'))[0];
      const changes: Record<string, unknown> = {
        userId: 'changed-user', submissionId: 'changed-book', quantity: 2, zone: 'eu', weightGrams: 201, shippingBand: 2,
        vaultAddOn: true, vaultFeeHuf: 20, unitPriceHuf: 123, printCostHuf: 123, handlingCostHuf: 20,
        shippingCostHuf: 123, discountHuf: 123, totalHuf: 123, currency: 'EUR', pricingConfigVersion: 123,
        quoteSnapshot: '{}', expectedMinorAmount: 410000, fxRate: 0.1, quoteAcceptedAt: new Date(),
        requestKey: 'changed-key', requestDigest: 'changed-digest', recipientName: 'changed', line1: 'changed',
        line2: 'changed', city: 'changed', postalCode: 'changed', countryCode: 'DE', phone: 'changed',
      };
      for (const [column, value] of Object.entries(changes)) {
        await savepointReject(tx, () => tx.$executeRawUnsafe(`UPDATE "Order" SET "${column}" = $1${column === 'quoteSnapshot' ? '::jsonb' : ''} WHERE "id" = $2`, value, order.id), 'immutable');
      }
      expect((await tx.$queryRawUnsafe<Array<Record<string, unknown>>>('SELECT * FROM "Order" WHERE "expectedMinorAmount" IS NOT NULL'))[0]).toEqual(frozen);
      await tx.$executeRaw`UPDATE "Order" SET "status" = 'PAID', "notes" = 'allowed', "stripeSessionId" = 'synthetic-session' WHERE "id" = ${order.id}`;
      expect(await tx.$queryRawUnsafe('SELECT "fxRate", "quoteAcceptedAt" FROM "Order" WHERE "expectedMinorAmount" IS NOT NULL')).toEqual([{ fxRate: null, quoteAcceptedAt: null }]);
    });
  });
  it('rejects incomplete accepted snapshots, invalid amounts, and duplicate user request keys without deleting legacy rows', async () => {
    const user = await createUser(); const first = await createOrderForUser(user.id); const second = await createOrderForUser(user.id);
    await rehearsal(async tx => {
      await legacyTable(tx); await apply(tx);
      await savepointReject(tx, () => tx.$executeRaw`UPDATE "Order" SET "requestKey" = 'same-key' WHERE "id" = ${first.order.id}`);
      for (const amount of [0, -1, 400001, 100000000]) {
        await savepointReject(tx, () => tx.$executeRaw`UPDATE "Order" SET "expectedMinorAmount" = ${amount} WHERE "id" = ${first.order.id}`);
      }
      await tx.$executeRaw`UPDATE "Order" SET "requestKey" = 'same-key', "requestDigest" = 'digest', "quoteSnapshot" = '{}', "expectedMinorAmount" = 400000, "fxRate" = 1, "quoteAcceptedAt" = NOW() WHERE "id" = ${first.order.id}`;
      await savepointReject(tx, () => tx.$executeRaw`UPDATE "Order" SET "requestKey" = 'same-key', "requestDigest" = 'digest', "quoteSnapshot" = '{}', "expectedMinorAmount" = 400000, "fxRate" = 1, "quoteAcceptedAt" = NOW() WHERE "id" = ${second.order.id}`);
      expect(await tx.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "Order"')).toEqual([{ count: 2 }]);
    });
  });
});
