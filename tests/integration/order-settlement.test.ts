import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, createUser, cleanupFixtures } from '../fixtures/database';
import { createPendingOrderWithUser } from '../fixtures/orders';
import { WEBHOOK_SECRET, completedEvent, signedEventRequest, installSyntheticWebhookProvider } from '../fixtures/stripe-events';
import { PATCH as adminPatch } from '@/app/api/admin/orders/[id]/route';
import { POST as webhook } from '@/app/api/stripe/webhook/route';
import { applyOrderLifecycle } from '@/lib/orders/lifecycle';
import { ORDER_STATUS_TRANSITIONS, ORDER_STATUSES } from '@/lib/pricing/constants';
import * as stripeService from '@/lib/stripe';

const session = vi.hoisted(() => ({ user: null as null | { id: string; role: string } }));
const fault = vi.hoisted(() => ({ fail: false }));
vi.mock('@/auth', () => ({ auth: async () => session.user ? { user: session.user } : null }));
vi.mock('@/lib/prisma', async () => {
  const { db } = await import('../fixtures/database');
  return { prisma: db.$extends({ query: { vaultEntry: {
    async upsert({ args, query }) {
      const row = await query(args);
      if (fault.fail) { fault.fail = false; throw new Error('Injected failure after Vault write'); }
      return row;
    },
  } } }) };
});
const evidence = { method: 'BANK_TRANSFER', reference: 'Isolated receipt 42', confirmed: true };
const paidBody = { status: 'PAID', manualSettlement: evidence };
const paidAt = new Date('2026-01-02T03:04:05.000Z');
function patch(id: string, body: unknown) {
  return adminPatch(new Request(`http://localhost/api/admin/orders/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}
function deliver(id: string, sessionId: string) {
  return webhook(signedEventRequest(completedEvent(id, sessionId)));
}
async function asAdmin() {
  const admin = await createUser('ADMIN');
  session.user = { id: admin.id, role: 'ADMIN' };
  return admin;
}
async function orderState(id: string) {
  return db.order.findUniqueOrThrow({ where: { id }, include: { vaultEntries: true } });
}
function checkoutSession(patch: Record<string, unknown>) {
  return { id: 'cs_test_manual_open', mode: 'payment', client_reference_id: 'order', metadata: {}, livemode: false,
    currency: 'huf', amount_total: 4000, url: null, ...patch } as unknown as Awaited<ReturnType<typeof stripeService.retrieveOrderCheckoutSession>>;
}
beforeAll(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_integration_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
});
beforeEach(installSyntheticWebhookProvider);
afterEach(async () => { fault.fail = false; session.user = null; await cleanupFixtures(); });

describe('atomic order settlement', () => {
  it('requires bounded evidence and confirmation, refusing forged operator metadata', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true });
    for (const manualSettlement of [undefined, {}, { ...evidence, reference: '   ' },
      { ...evidence, reference: 'x'.repeat(501) }, { ...evidence, confirmed: false },
      { ...evidence, operatorId: 'forged' }, { ...evidence, method: 'STRIPE' }]) {
      expect((await patch(order.id, { status: 'PAID', manualSettlement })).status).toBe(400);
    }
    expect((await patch(order.id, { status: 'CANCELLED', manualSettlement: evidence })).status).toBe(400);
    expect(await orderState(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paidAt: null, manualSettlement: null, vaultEntries: [] });
  });

  it('records only authenticated operator evidence and preserves it on repeats', async () => {
    const admin = await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true });
    expect((await patch(order.id, paidBody)).status).toBe(200);
    const first = await orderState(order.id);
    expect(first.manualSettlement).toMatchObject({ ...evidence, source: 'manual', operatorId: admin.id, recordedAt: expect.any(String) });
    expect(first.vaultEntries).toHaveLength(1);
    expect(first.vaultEntries[0]).toMatchObject({ publicConsent: false, quantity: 2 });
    expect((await patch(order.id, { ...paidBody, manualSettlement: { ...evidence, reference: 'different' } })).status).toBe(200);
    expect((await orderState(order.id)).manualSettlement).toEqual(first.manualSettlement);
    expect((await orderState(order.id)).paidAt).toEqual(first.paidAt);
  });

  it('serializes simultaneous admin/admin settlement without duplicate effects', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true });
    const responses = await Promise.all(Array.from({ length: 8 }, () => patch(order.id, paidBody)));
    expect(responses.map(res => res.status)).toEqual(Array(8).fill(200));
    expect(await orderState(order.id)).toMatchObject({ status: 'PAID', paidAt: expect.any(Date) });
    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('serializes simultaneous admin/webhook and duplicate signed deliveries', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true, stripeSessionId: 'cs_test_race' });
    const responses = await Promise.all([
      patch(order.id, paidBody), patch(order.id, paidBody),
      ...Array.from({ length: 6 }, () => deliver(order.id, order.stripeSessionId!)),
    ]);
    expect(responses.slice(0, 2).every(res => [200, 409].includes(res.status))).toBe(true);
    expect(responses.slice(2).map(res => res.status)).toEqual(Array(6).fill(200));
    const settled = await orderState(order.id);
    expect(settled.status).toBe('PAID');
    expect(settled.vaultEntries).toHaveLength(1);
    expect(settled.vaultEntries[0].publicConsent).toBe(false);
    expect((await deliver(order.id, order.stripeSessionId!)).status).toBe(200);
    expect((await orderState(order.id)).paidAt).toEqual(settled.paidAt);
    expect((await orderState(order.id)).manualSettlement).toEqual(settled.manualSettlement);
  });

  it.each(['PAID', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED'] as const)('late events preserve %s, paidAt, and existing consent/withdrawal', async status => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ status, vaultAddOn: true, stripeSessionId: `cs_test_${status}` });
    await db.order.update({ where: { id: order.id }, data: { paidAt } });
    // Recover a historical missing entry without resetting fulfillment.
    expect((await deliver(order.id, order.stripeSessionId!)).status).toBe(200);
    const first = await orderState(order.id);
    expect(first).toMatchObject({ status, paidAt, manualSettlement: null });
    const entry = await db.vaultEntry.update({ where: { orderId: order.id }, data: {
      publicConsent: true, status: 'WITHDRAWN', withdrawnAt: paidAt, title: 'Historical title', quantity: 7,
    } });
    expect((await deliver(order.id, order.stripeSessionId!)).status).toBe(200);
    expect(await db.vaultEntry.findUnique({ where: { orderId: order.id } })).toEqual(entry);
    expect((await orderState(order.id)).status).toBe(status);
    if (status !== 'PAID') expect((await patch(order.id, paidBody)).status).toBe(400);
  });

  it('does not fabricate unknown paidAt for a legacy fulfilled row', async () => {
    const { order } = await createPendingOrderWithUser({ status: 'SHIPPED', vaultAddOn: true, stripeSessionId: 'cs_test_legacy' });
    expect((await deliver(order.id, order.stripeSessionId!)).status).toBe(200);
    expect(await orderState(order.id)).toMatchObject({ status: 'SHIPPED', paidAt: null, manualSettlement: null });
  });

  it('does not revive canceled orders or create Vault rows for them', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ status: 'CANCELLED', vaultAddOn: true, stripeSessionId: 'cs_test_cancelled' });
    expect((await deliver(order.id, order.stripeSessionId!)).status).toBe(200);
    expect((await patch(order.id, paidBody)).status).toBe(400);
    expect(await orderState(order.id)).toMatchObject({ status: 'CANCELLED', paidAt: null, vaultEntries: [] });
  });

  it('rolls back status, timestamp, evidence, notes AND inserted Vault row on admin failure, then retries', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true });
    fault.fail = true;
    const body = { ...paidBody, notes: 'Verified receipt', expectedUpdatedAt: order.updatedAt.toISOString() };
    expect((await patch(order.id, body)).status).toBe(503);
    expect(await orderState(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paidAt: null, manualSettlement: null, notes: null, updatedAt: order.updatedAt, vaultEntries: [] });
    expect((await patch(order.id, body)).status).toBe(200);
    expect((await orderState(order.id)).vaultEntries).toHaveLength(1);
  });

  it('rolls back signed webhook settlement on Vault failure and recovers through retry', async () => {
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true, stripeSessionId: 'cs_test_rollback' });
    fault.fail = true;
    expect((await deliver(order.id, order.stripeSessionId!)).status).toBe(500);
    expect(await orderState(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paidAt: null, vaultEntries: [] });
    expect((await deliver(order.id, order.stripeSessionId!)).status).toBe(200);
    expect((await orderState(order.id)).vaultEntries).toHaveLength(1);
  });

  it('rejects stale notes/status edits atomically and keeps the winning notes', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser();
    const responses = await Promise.all(['one', 'two'].map(notes => patch(order.id, { notes, expectedUpdatedAt: order.updatedAt.toISOString() })));
    expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
    const winner = await orderState(order.id);
    expect(['one', 'two']).toContain(winner.notes);
    expect((await patch(order.id, { status: 'CANCELLED', notes: 'stale', expectedUpdatedAt: order.updatedAt.toISOString() })).status).toBe(409);
    expect((await orderState(order.id)).status).toBe('PENDING_PAYMENT');
    expect((await patch(order.id, { notes: 'no version' })).status).toBe(400);
  });

  it.each(ORDER_STATUSES.flatMap(from => ORDER_STATUSES.map(to => ({ from, to }))))(
    'enforces fulfillment transition $from -> $to under lock', async ({ from, to }) => {
      await asAdmin();
      const { order } = await createPendingOrderWithUser({ status: from });
      const allowed = from === to || ORDER_STATUS_TRANSITIONS[from].includes(to);
      const res = await patch(order.id, { status: to, ...(to === 'PAID' ? { manualSettlement: evidence } : {}) });
      expect(res.status, `${from} -> ${to}`).toBe(allowed ? 200 : 400);
      expect((await orderState(order.id)).status).toBe(allowed ? to : from);
    });

  it('does not allow concurrent cancellation and production to overwrite each other', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ status: 'PAID' });
    const results = await Promise.all(['IN_PRODUCTION', 'CANCELLED'].map(status => patch(order.id, {
      status, expectedUpdatedAt: order.updatedAt.toISOString(),
    })));
    expect(results.map(res => res.status).sort()).toEqual([200, 409]);
    expect(['IN_PRODUCTION', 'CANCELLED']).toContain((await orderState(order.id)).status);
  });

  it('waits for the row lock, then checks the committed status/version before changing anything', async () => {
    const admin = await asAdmin();
    const { order } = await createPendingOrderWithUser({ status: 'PAID' });
    let unlock!: () => void;
    let ready!: () => void;
    let ownerPid!: number;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const owner = db.$transaction(async tx => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      ownerPid = pid;
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      ready();
      await gate;
      return applyOrderLifecycle(tx, order.id, { source: 'admin', operatorId: admin.id, update: { status: 'IN_PRODUCTION' } });
    }, { timeout: 15000 });
    await locked;
    const waiter = patch(order.id, { status: 'CANCELLED', expectedUpdatedAt: order.updatedAt.toISOString() });
    try {
      await vi.waitFor(async () => {
        // Only a waiter blocked by this test's own lock owner counts: another
        // session holding an Order lock must not satisfy the observation.
        const rows = await db.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%SELECT "id" FROM "Order"%' AND ${ownerPid} = ANY(pg_blocking_pids(pid))`;
        expect(Number(rows[0].count)).toBeGreaterThan(0);
      }, { timeout: 3000 });
    } finally { unlock(); }
    expect((await owner).ok).toBe(true);
    expect((await waiter).status).toBe(409);
    expect((await orderState(order.id)).status).toBe('IN_PRODUCTION');
  });

  it('never labels an already Stripe-settled order as manually paid', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_stripe_first' });
    expect((await deliver(order.id, order.stripeSessionId!)).status).toBe(200);
    const first = await orderState(order.id);
    expect((await patch(order.id, paidBody)).status).toBe(200);
    expect(await orderState(order.id)).toMatchObject({ paidAt: first.paidAt, manualSettlement: null });
  });

  it('has a database uniqueness backstop, even for writers bypassing the service', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true });
    await patch(order.id, paidBody);
    const entry = await db.vaultEntry.findUniqueOrThrow({ where: { orderId: order.id } });
    await expect(db.vaultEntry.create({ data: { ...entry, id: `${entry.id}-duplicate` } })).rejects.toMatchObject({ code: 'P2002' });
    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('works within an enclosing transaction and rolls back on caller failure', async () => {
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true });
    await expect(db.$transaction(async tx => {
      expect((await applyOrderLifecycle(tx, order.id, { source: 'stripe' })).ok).toBe(true);
      throw new Error('Caller failure');
    })).rejects.toThrow('Caller failure');
    expect(await orderState(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', vaultEntries: [] });
  });

  it('denies unauthenticated/nonadmin mutation and reports a missing order', async () => {
    const { user, order } = await createPendingOrderWithUser();
    expect((await patch(order.id, paidBody)).status).toBe(403);
    session.user = { id: user.id, role: 'USER' };
    expect((await patch(order.id, paidBody)).status).toBe(403);
    await asAdmin();
    expect((await patch('absent-order', paidBody)).status).toBe(404);
  });

  it('expires an open unpaid checkout session before recording a manual settlement', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true, stripeSessionId: 'cs_test_manual_open' });
    vi.spyOn(stripeService, 'retrieveOrderCheckoutSession').mockResolvedValueOnce(checkoutSession({ status: 'open', payment_status: 'unpaid' }));
    const expire = vi.spyOn(stripeService, 'expireCheckoutSession').mockResolvedValue(undefined);
    expect((await patch(order.id, paidBody)).status).toBe(200);
    expect(expire).toHaveBeenCalledWith('cs_test_manual_open');
    expect(await orderState(order.id)).toMatchObject({ status: 'PAID', manualSettlement: { source: 'manual' } });
  });

  it('refuses manual settlement while a Stripe payment is already in progress', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true, stripeSessionId: 'cs_test_manual_paid' });
    vi.spyOn(stripeService, 'retrieveOrderCheckoutSession').mockResolvedValueOnce(checkoutSession({ id: 'cs_test_manual_paid', status: 'complete', payment_status: 'paid' }));
    const expire = vi.spyOn(stripeService, 'expireCheckoutSession').mockResolvedValue(undefined);
    const res = await patch(order.id, paidBody);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PAYMENT_REVIEW_REQUIRED');
    expect(expire).not.toHaveBeenCalled();
    expect(await orderState(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paidAt: null, manualSettlement: null, vaultEntries: [] });
  });

  it('refuses manual settlement when the open session cannot be closed', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true, stripeSessionId: 'cs_test_manual_race' });
    vi.spyOn(stripeService, 'retrieveOrderCheckoutSession').mockResolvedValueOnce(checkoutSession({ id: 'cs_test_manual_race', status: 'open', payment_status: 'unpaid' }));
    vi.spyOn(stripeService, 'expireCheckoutSession').mockRejectedValueOnce(new Error('Session already completed'));
    const res = await patch(order.id, paidBody);
    expect(res.status).toBe(409);
    expect(await orderState(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paidAt: null, manualSettlement: null, vaultEntries: [] });
  });
});
