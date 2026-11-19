import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { cleanupFixtures, createUser, db } from '../fixtures/database';
import { createOrderForUser } from '../fixtures/orders';

const migration = readFileSync('prisma/migrations/20261120120000_payment_reconciliation/migration.sql', 'utf8');
const statements = migration.match(/BEGIN;|CREATE TYPE[^;]+;|ALTER TABLE[^;]+;|CREATE TABLE[\s\S]*?;|CREATE (?:UNIQUE )?INDEX[^;]+;|CREATE FUNCTION[\s\S]*?\$\$;|CREATE TRIGGER[^;]+;|COMMIT;/g)!;
const added = ['paymentState', 'paymentSummary', 'paymentHold', 'paymentRevision'];
afterEach(async () => { await cleanupFixtures(); });

async function rehearsal(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await db.$transaction(async tx => { await work(tx); throw new Error('ROLLBACK_PAYMENT_REHEARSAL'); }, { timeout: 30000 });
  } catch (error) { if (!(error instanceof Error) || error.message !== 'ROLLBACK_PAYMENT_REHEARSAL') throw error; }
}
async function apply(tx: Prisma.TransactionClient) {
  // Prove the parser does not silently omit any executable migration statement.
  expect(statements.join('').replace(/\s/g, '')).toBe(migration.replace(/^--.*$/gm, '').replace(/\s/g, ''));
  await tx.$executeRawUnsafe('CREATE TEMP TABLE "Order" AS TABLE public."Order"');
  for (const column of added) await tx.$executeRawUnsafe(`ALTER TABLE "Order" DROP COLUMN "${column}"`);
  await tx.$executeRawUnsafe('ALTER TABLE "Order" ADD PRIMARY KEY ("id")');
  for (let sql of statements.slice(1, -1)) {
    // Exact SQL bodies, with namespace/table lifetime changes only, all rolled back.
    for (const name of ['OrderPaymentState', 'PaymentAttemptStatus', 'PaymentEventStatus', 'protect_payment_attempt', 'protect_payment_fulfillment']) {
      sql = sql.replaceAll(`"${name}"`, `pg_temp."${name}"`);
    }
    sql = sql.replace('CREATE TABLE', 'CREATE TEMP TABLE');
    await tx.$executeRawUnsafe(sql);
  }
}
async function rejected(tx: Prisma.TransactionClient, operation: () => Promise<unknown>, message?: RegExp | string) {
  await tx.$executeRawUnsafe('SAVEPOINT rejected_payment_write');
  if (typeof message === 'string') await expect(operation()).rejects.toMatchObject({ meta: { code: message } });
  else await expect(operation()).rejects.toThrow(message);
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rejected_payment_write');
}
async function attempt(tx: Prisma.TransactionClient, orderId: string, id = 'synthetic-attempt', sequence = 1, key = 'synthetic-key') {
  await tx.$executeRaw`INSERT INTO "PaymentAttempt" ("id", "orderId", "sequence", "idempotencyKey", "expectedMinorAmount", "currency", "livemode", "providerRequest", "updatedAt")
    VALUES (${id}, ${orderId}, ${sequence}, ${key}, 400000, 'HUF', false, '{"mode":"payment"}', NOW())`;
}

describe('additive payment reconciliation migration', () => {
  it('preserves existing IDs, unknown payments, accepted quotes, artifacts, Vault consent and the synthetic provider-schema probe', async () => {
    const user = await createUser();
    const { order, submission } = await createOrderForUser(user.id, { status: 'SHIPPED', vaultAddOn: true });
    await db.order.update({ where: { id: order.id }, data: {
      paidAt: new Date('2020-01-02T03:04:05Z'), expectedMinorAmount: 600000,
      quoteSnapshot: { origin: 'LEGACY_STRIPE_SESSION', amountMinor: 600000 },
    } });
    const vault = await db.vaultEntry.create({ data: { orderId: order.id, submissionId: submission.id,
      title: 'Original Émilie', authorName: 'Synthetic Original', quantity: 2, publicConsent: true, status: 'WITHDRAWN' } });
    const before = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    await rehearsal(async tx => {
      await tx.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS neon_auth');
      await tx.$executeRawUnsafe('CREATE TABLE neon_auth.batch5_payment_preservation_probe (id TEXT, value TEXT)');
      await tx.$executeRawUnsafe("INSERT INTO neon_auth.batch5_payment_preservation_probe VALUES ('synthetic-original', 'preserve')");
      const probe = await tx.$queryRawUnsafe('SELECT * FROM neon_auth.batch5_payment_preservation_probe');
      await apply(tx);
      const columns = Object.keys(before).filter(key => !added.includes(key)).map(key => `"${key}"`).join(',');
      const original = await tx.$queryRawUnsafe(`SELECT ${columns} FROM public."Order" ORDER BY "id"`);
      expect(await tx.$queryRawUnsafe(`SELECT ${columns} FROM "Order" ORDER BY "id"`)).toEqual(original);
      expect(await tx.$queryRawUnsafe('SELECT "paymentState", "paymentSummary", "paymentHold", "paymentRevision" FROM "Order"'))
        .toEqual([{ paymentState: null, paymentSummary: null, paymentHold: false, paymentRevision: 0 }]);
      expect(await tx.$queryRawUnsafe('SELECT to_jsonb(a) AS row FROM "PaymentAttempt" a')).toEqual([]);
      expect(await tx.$queryRawUnsafe('SELECT * FROM "PaymentEvent"')).toEqual([]);
      expect(await tx.$queryRawUnsafe('SELECT * FROM neon_auth.batch5_payment_preservation_probe')).toEqual(probe);
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toEqual(before);
    expect(await db.vaultEntry.findUniqueOrThrow({ where: { id: vault.id } })).toEqual(vault);
    expect(await db.submission.findUniqueOrThrow({ where: { id: submission.id } })).toEqual(submission);
  });

  it('freezes attempt terms, identities and original request time while permitting canonical outcomes', async () => {
    const user = await createUser(); const { order } = await createOrderForUser(user.id);
    await rehearsal(async tx => {
      await apply(tx); await attempt(tx, order.id);
      await tx.$executeRaw`UPDATE "PaymentAttempt" SET "providerAccountId" = 'acct_synthetic', "sessionId" = 'cs_synthetic',
        "paymentIntentId" = 'pi_synthetic', "requestStartedAt" = '2020-01-02T03:04:05Z', "status" = 'OPEN' WHERE "id" = 'synthetic-attempt'`;
      const before = await tx.$queryRawUnsafe('SELECT to_jsonb(a) AS row FROM "PaymentAttempt" a');
      const changes: Record<string, unknown> = { orderId: 'other', sequence: 2, idempotencyKey: 'other',
        expectedMinorAmount: 500000, currency: 'EUR', livemode: true, providerRequest: '{}', createdAt: new Date(),
        providerAccountId: 'acct_other', sessionId: 'cs_other', paymentIntentId: 'pi_other', requestStartedAt: new Date() };
      for (const [column, value] of Object.entries(changes)) {
        await rejected(tx, () => tx.$executeRawUnsafe(`UPDATE "PaymentAttempt" SET "${column}" = $1${column === 'providerRequest' ? '::jsonb' : ''} WHERE "id" = 'synthetic-attempt'`, value), /immutable/);
      }
      expect(await tx.$queryRawUnsafe('SELECT to_jsonb(a) AS row FROM "PaymentAttempt" a')).toEqual(before);
      await tx.$executeRaw`UPDATE "PaymentAttempt" SET "status" = 'SUCCEEDED', "providerSnapshot" = '{"receivedMinor":400000}', "failureCode" = NULL WHERE "id" = 'synthetic-attempt'`;
      expect(await tx.$queryRawUnsafe('SELECT "status"::text AS status FROM "PaymentAttempt"')).toEqual([{ status: 'SUCCEEDED' }]);
    });
  });

  it('rejects duplicate provider/idempotency identifiers and malformed financial facts without losing the original attempt', async () => {
    const user = await createUser(); const { order } = await createOrderForUser(user.id);
    await rehearsal(async tx => {
      await apply(tx); await attempt(tx, order.id);
      await rejected(tx, () => attempt(tx, order.id, 'duplicate-key', 2), '23505');
      await rejected(tx, () => attempt(tx, order.id, 'duplicate-sequence', 1, 'other-key'), '23505');
      for (const amount of [0, -1, 400001, 100000000]) {
        await rejected(tx, () => tx.$executeRaw`INSERT INTO "PaymentAttempt" ("id", "orderId", "sequence", "idempotencyKey", "expectedMinorAmount", "currency", "livemode", "providerRequest", "updatedAt")
          VALUES ('invalid', ${order.id}, 2, 'invalid', ${amount}, 'HUF', false, '{}', NOW())`, '23514');
      }
      await attempt(tx, order.id, 'second', 2, 'second-key');
      await tx.$executeRaw`UPDATE "PaymentAttempt" SET "sessionId" = 'cs_synthetic', "paymentIntentId" = 'pi_synthetic' WHERE "id" = 'synthetic-attempt'`;
      await rejected(tx, () => tx.$executeRaw`UPDATE "PaymentAttempt" SET "sessionId" = 'cs_synthetic' WHERE "id" = 'second'`, '23505');
      await rejected(tx, () => tx.$executeRaw`UPDATE "PaymentAttempt" SET "paymentIntentId" = 'pi_synthetic' WHERE "id" = 'second'`, '23505');
      expect(await tx.$queryRawUnsafe('SELECT COUNT(*)::int AS count FROM "PaymentAttempt"')).toEqual([{ count: 2 }]);
    });
  });

  it('retains orphaned events, uniquely records deliveries, and restricts removal of orders with payment attempts', async () => {
    const user = await createUser(); const { order } = await createOrderForUser(user.id);
    await rehearsal(async tx => {
      await apply(tx); await attempt(tx, order.id);
      await tx.$executeRaw`INSERT INTO "PaymentEvent" ("id", "providerEventId", "source", "type", "orderId", "attemptId", "data", "dataDigest", "updatedAt")
        VALUES ('event', 'evt_synthetic', 'SIGNED_WEBHOOK', 'checkout.session.completed', ${order.id}, 'synthetic-attempt', '{"objectId":"cs_synthetic"}', 'digest', NOW())`;
      await rejected(tx, () => tx.$executeRaw`INSERT INTO "PaymentEvent" ("id", "providerEventId", "source", "type", "data", "dataDigest", "updatedAt")
        VALUES ('duplicate', 'evt_synthetic', 'SIGNED_WEBHOOK', 'other', '{}', 'digest', NOW())`, '23505');
      await rejected(tx, () => tx.$executeRaw`DELETE FROM "Order" WHERE "id" = ${order.id}`, '23503');
      await tx.$executeRaw`DELETE FROM "PaymentAttempt" WHERE "id" = 'synthetic-attempt'`;
      await tx.$executeRaw`DELETE FROM "Order" WHERE "id" = ${order.id}`;
      expect(await tx.$queryRawUnsafe('SELECT "providerEventId", "orderId", "attemptId", "data" FROM "PaymentEvent"'))
        .toEqual([{ providerEventId: 'evt_synthetic', orderId: null, attemptId: null, data: { objectId: 'cs_synthetic' } }]);
    });
  });

  it('enforces the unstarted fulfillment hold independently of payment state and leaves shipped/Vault history untouched', async () => {
    const user = await createUser(); const { order } = await createOrderForUser(user.id, { status: 'PAID' });
    await rehearsal(async tx => {
      await apply(tx);
      await tx.$executeRaw`UPDATE "Order" SET "paymentHold" = true, "paymentState" = 'REFUNDED' WHERE "id" = ${order.id}`;
      for (const status of ['IN_PRODUCTION', 'SHIPPED', 'DELIVERED']) {
        await rejected(tx, () => tx.$executeRawUnsafe('UPDATE "Order" SET "status" = $1::"OrderStatus" WHERE "id" = $2', status, order.id), /Payment review/);
      }
      // An explicit application review may release the hold; the release is audited by its service.
      await tx.$executeRaw`UPDATE "Order" SET "paymentHold" = false WHERE "id" = ${order.id}`;
      await tx.$executeRaw`UPDATE "Order" SET "status" = 'IN_PRODUCTION' WHERE "id" = ${order.id}`;
      await tx.$executeRaw`UPDATE "Order" SET "paymentHold" = true, "paymentState" = 'DISPUTED' WHERE "id" = ${order.id}`;
      await tx.$executeRaw`UPDATE "Order" SET "status" = 'SHIPPED' WHERE "id" = ${order.id}`;
      expect(await tx.$queryRawUnsafe('SELECT "status"::text AS status, "paymentState"::text AS state, "paymentHold" FROM "Order"'))
        .toEqual([{ status: 'SHIPPED', state: 'DISPUTED', paymentHold: true }]);
    });
  });
});
