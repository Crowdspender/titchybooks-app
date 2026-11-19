import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { cleanupFixtures, createUser, db } from '../fixtures/database';
import { createOrderForUser } from '../fixtures/orders';

const migration = readFileSync('prisma/migrations/20261121120000_quote_hold_backstops/migration.sql', 'utf8');
const statements = migration.match(/BEGIN;|ALTER TABLE[^;]+;|CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;|COMMIT;/g)!;
// The follow-up replaces exactly these landed constraints; recreate them on the
// shadow so the rehearsal exercises the real upgrade path, not a blank table.
const landed = readFileSync('prisma/migrations/20261119120000_immutable_order_quotes/migration.sql', 'utf8');
const priorConstraints = landed.match(/ALTER TABLE "Order" ADD CONSTRAINT "Order_(accepted_quote_complete|fx_range)"[^;]+;/g)!;
afterEach(async () => { await cleanupFixtures(); });

async function rehearsal(work: (tx: Prisma.TransactionClient) => Promise<void>) {
  try {
    await db.$transaction(async tx => { await work(tx); throw new Error('ROLLBACK_BACKSTOP_REHEARSAL'); }, { timeout: 30000 });
  } catch (error) { if (!(error instanceof Error) || error.message !== 'ROLLBACK_BACKSTOP_REHEARSAL') throw error; }
}
async function apply(tx: Prisma.TransactionClient) {
  // Prove the parser does not silently omit any executable migration statement.
  expect(statements.join('').replace(/\s/g, '')).toBe(migration.replace(/^--.*$/gm, '').replace(/\s/g, ''));
  expect(statements).toHaveLength(7);
  expect(statements[0]).toBe('BEGIN;'); expect(statements.at(-1)).toBe('COMMIT;');
  expect(priorConstraints).toHaveLength(2);
  await tx.$executeRawUnsafe('CREATE TEMP TABLE "Order" AS TABLE public."Order"');
  await tx.$executeRawUnsafe('ALTER TABLE "Order" ADD PRIMARY KEY ("id")');
  for (const sql of priorConstraints) await tx.$executeRawUnsafe(sql);
  for (let sql of statements.slice(1, -1)) {
    // Exact SQL bodies; only the function namespace changes for the shadow.
    sql = sql.replaceAll('"protect_payment_fulfillment"', 'pg_temp."protect_payment_fulfillment"');
    await tx.$executeRawUnsafe(sql);
  }
  // The landed trigger already binds this function on public."Order"; bind the
  // replacement on the shadow to exercise its behavior.
  await tx.$executeRawUnsafe('CREATE TRIGGER "Order_payment_fulfillment_hold" BEFORE UPDATE ON "Order" FOR EACH ROW EXECUTE FUNCTION pg_temp."protect_payment_fulfillment"()');
}
async function rejected(tx: Prisma.TransactionClient, operation: () => Promise<unknown>, message?: RegExp | string) {
  await tx.$executeRawUnsafe('SAVEPOINT rejected_backstop_write');
  if (typeof message === 'string') await expect(operation()).rejects.toMatchObject({ meta: { code: message } });
  else await expect(operation()).rejects.toThrow(message);
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT rejected_backstop_write');
}

describe('quote/hold backstop tightening migration', () => {
  it('preserves landed rows while requiring a replay key for acceptance facts and rejecting nonfinite FX', async () => {
    const user = await createUser();
    const { order: legacy } = await createOrderForUser(user.id);
    const { order: accepted } = await createOrderForUser(user.id);
    await db.order.update({ where: { id: legacy.id }, data: {
      expectedMinorAmount: 400000, quoteSnapshot: { origin: 'LEGACY_STRIPE_SESSION' } } });
    await db.order.update({ where: { id: accepted.id }, data: {
      requestKey: 'backstop-key', requestDigest: 'backstop-digest', quoteSnapshot: {},
      expectedMinorAmount: 400000, fxRate: 1, quoteAcceptedAt: new Date('2026-01-02T03:04:05Z') } });
    await rehearsal(async tx => {
      const before = await tx.$queryRawUnsafe('SELECT * FROM public."Order" ORDER BY "id"');
      await apply(tx);
      expect(await tx.$queryRawUnsafe('SELECT * FROM "Order" ORDER BY "id"')).toEqual(before);
      // Acceptance-only facts without a replay key are now rejected on legacy rows.
      await rejected(tx, () => tx.$executeRawUnsafe(`UPDATE "Order" SET "fxRate" = 1 WHERE "id" = '${legacy.id}'`), '23514');
      await rejected(tx, () => tx.$executeRawUnsafe(`UPDATE "Order" SET "quoteAcceptedAt" = NOW() WHERE "id" = '${legacy.id}'`), '23514');
      // The legacy backfill itself stays legal: amount/snapshot without acceptance facts.
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "expectedMinorAmount" = 500000 WHERE "id" = '${legacy.id}'`);
      // NaN sorts above every finite numeric: the upper bound rejects it.
      for (const rate of ["'NaN'", '11', '0', '-1']) {
        await rejected(tx, () => tx.$executeRawUnsafe(`UPDATE "Order" SET "fxRate" = ${rate} WHERE "id" = '${accepted.id}'`), '23514');
      }
      // Infinity never even reaches the constraint: numeric(24,18) overflow.
      await rejected(tx, () => tx.$executeRawUnsafe(`UPDATE "Order" SET "fxRate" = 'Infinity' WHERE "id" = '${accepted.id}'`), '22003');
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "fxRate" = 0.0026 WHERE "id" = '${accepted.id}'`);
      expect(await tx.$queryRawUnsafe(`SELECT "fxRate"::float8 AS rate FROM "Order" WHERE "id" = '${accepted.id}'`)).toEqual([{ rate: 0.0026 }]);
      // A half-written replay identity is still rejected.
      await rejected(tx, () => tx.$executeRawUnsafe(`UPDATE "Order" SET "requestKey" = 'half-key' WHERE "id" = '${legacy.id}'`), '23514');
    });
    // Post-rollback isolation: the rehearsal never touched the real rows.
    expect(await db.order.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ expectedMinorAmount: 400000, fxRate: null });
    expect(await db.order.findUniqueOrThrow({ where: { id: accepted.id } })).toMatchObject({
      expectedMinorAmount: 400000, requestKey: 'backstop-key', quoteAcceptedAt: new Date('2026-01-02T03:04:05Z') });
  });

  it('requires the hold to be released before fulfillment starts and keeps fulfilled history', async () => {
    const user = await createUser();
    const { order: paid } = await createOrderForUser(user.id, { status: 'PAID' });
    const { order: pending } = await createOrderForUser(user.id);
    await rehearsal(async tx => {
      await apply(tx);
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "paymentHold" = true WHERE "id" IN ('${paid.id}', '${pending.id}')`);
      // One update that clears the hold and advances status must not bypass review.
      await rejected(tx, () => tx.$executeRawUnsafe(`UPDATE "Order" SET "paymentHold" = false, "status" = 'IN_PRODUCTION' WHERE "id" = '${paid.id}'`), /Payment review/);
      await rejected(tx, () => tx.$executeRawUnsafe(`UPDATE "Order" SET "paymentHold" = false, "status" = 'SHIPPED' WHERE "id" = '${pending.id}'`), /Payment review/);
      // Holding without releasing still blocks, exactly as before.
      await rejected(tx, () => tx.$executeRawUnsafe(`UPDATE "Order" SET "status" = 'IN_PRODUCTION' WHERE "id" = '${paid.id}'`), /Payment review/);
      // The authorized release is a separate transition; fulfillment then proceeds.
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "paymentHold" = false WHERE "id" = '${paid.id}'`);
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "status" = 'IN_PRODUCTION' WHERE "id" = '${paid.id}'`);
      // Fulfilled history is never blocked, even when a later dispute re-holds it.
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "paymentHold" = true WHERE "id" = '${paid.id}'`);
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "status" = 'SHIPPED' WHERE "id" = '${paid.id}'`);
      expect(await tx.$queryRawUnsafe(`SELECT "status"::text AS status, "paymentHold" FROM "Order" WHERE "id" = '${paid.id}'`))
        .toEqual([{ status: 'SHIPPED', paymentHold: true }]);
      // An unheld order still settles and fulfills without the review gate.
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "paymentHold" = false WHERE "id" = '${pending.id}'`);
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "status" = 'PAID' WHERE "id" = '${pending.id}'`);
      await tx.$executeRawUnsafe(`UPDATE "Order" SET "status" = 'IN_PRODUCTION' WHERE "id" = '${pending.id}'`);
    });
    expect(await db.order.findUniqueOrThrow({ where: { id: paid.id } })).toMatchObject({ status: 'PAID', paymentHold: false });
  });
});