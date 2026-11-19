import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, createUser, cleanupFixtures, trackPaymentEvent } from '../fixtures/database';
import { recordPaymentAlert } from '@/lib/orders/payment-alerts';
import { createPendingOrderWithUser } from '../fixtures/orders';
import {
  WEBHOOK_SECRET,
  completedEvent,
  signedEventRequest,
  installSyntheticWebhookProvider,
} from '../fixtures/stripe-events';
import { POST as webhook } from '@/app/api/stripe/webhook/route';
import { PATCH as updateOrder } from '@/app/api/admin/orders/[id]/route';
import { GET as listAlerts } from '@/app/api/admin/payment-alerts/route';
import { PATCH as resolveAlert } from '@/app/api/admin/payment-alerts/[id]/route';
const vaultFault = vi.hoisted(() => ({ fail: false }));

/**
 * Payment reconciliation alerts.
 *
 * Signed events now carry canonical outcomes; unknown sessions are held instead
 * of being honored on signature alone. Existing alerts remain readable and
 * manual-settlement failures still produce an operator-visible alert.
 */
const session = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; email: string | null },
}));
vi.mock('@/auth', () => ({ auth: async () => (session.user ? { user: session.user } : null) }));

// Fail after an actual Vault write inside the real transaction, proving rollback.
vi.mock('@/lib/prisma', async () => {
  const { db } = await import('../fixtures/database');
  return { prisma: db.$extends({ query: { vaultEntry: {
    async upsert({ args, query }) {
      const row = await query(args);
      if (vaultFault.fail) { vaultFault.fail = false; throw new Error('injected Vault failure'); }
      return row;
    },
  } } }) };
});

beforeAll(() => {
  // Cryptographic signatures are real; canonical provider reads are synthetic.
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_integration_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
});
beforeEach(() => {
  // A fault armed by a previous test must not leak into this one's Vault upsert
  // if that test's PATCH exited before consuming it.
  vaultFault.fail = false;
  installSyntheticWebhookProvider();
});
afterEach(cleanupFixtures);

/** Sign the mocked session in as a fresh administrator. */
async function asAdmin() {
  const admin = await createUser('ADMIN');
  session.user = { id: admin.id, role: 'ADMIN', email: admin.email };
}

function patchOrder(id: string, body: unknown) {
  return updateOrder(
    new Request(`http://localhost/api/admin/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function patchAlert(id: string) {
  return resolveAlert(new Request(`http://localhost/api/admin/payment-alerts/${id}`, {
    method: 'PATCH',
  }), { params: Promise.resolve({ id }) });
}

/** Deliver one signed event; a repeat delivery needs a fresh request body. */
function deliver(event: unknown) {
  return webhook(signedEventRequest(event));
}

async function alertsFor(orderId: string) {
  return db.paymentAlert.findMany({ where: { orderId }, orderBy: { firstSeenAt: 'asc' } });
}

async function eventsFor(orderId: string) {
  return db.paymentEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
}
async function raiseLegacyAlert(orderId: string) {
  await recordPaymentAlert({ kind: 'stale-session', orderId, subject: 'cs_test_superseded',
    message: 'Historical session requires review', context: { sessionId: 'cs_test_superseded', storedSessionId: 'cs_test_current' } });
}

describe('payment reconciliation alerts', () => {
  it('retains an unknown superseded session for review without fulfilling', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });

    const res = await deliver(completedEvent(order.id, 'cs_test_superseded'));
    expect(res.status).toBe(200);

    const held = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(held).toMatchObject({ status: 'PENDING_PAYMENT', paymentHold: true, stripeSessionId: 'cs_test_current' });
    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(0);
    const events = await eventsFor(order.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'REVIEW', data: { sessionId: 'cs_test_superseded' } });
  });

  it('does not record anything for a payment on the session it was issued for', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_matched' });

    expect((await deliver(completedEvent(order.id, 'cs_test_matched'))).status).toBe(200);
    expect(await alertsFor(order.id)).toHaveLength(0);
    expect((await eventsFor(order.id))[0].status).toBe('PROCESSED');
  });

  it('collapses Stripe retries of the same event into one durable outcome', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });
    const event = completedEvent(order.id, 'cs_test_superseded');

    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event)).status).toBe(200);

    const events = await eventsFor(order.id);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('REVIEW');
  });

  it('records an unpaid completion instead of leaving it in the log alone', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });

    const res = await deliver(
      completedEvent(order.id, 'cs_test_current', { paymentStatus: 'unpaid' }),
    );
    expect(res.status).toBe(200);

    const still = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(still.status).toBe('PENDING_PAYMENT');
    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(0);

    const events = await eventsFor(order.id);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ sessionId: 'cs_test_current', paymentStatus: 'unpaid' });
  });

  it('records an unpaid completion for an order that is no longer stored', async () => {
    // A user only so cleanupFixtures runs: the alert this raises has no order
    // to cascade from, and leaving it behind would surface in later tests.
    await createUser();
    // orderId is a foreign key, so the alert has to be raised without one
    // rather than failing the write the handler is relying on.
    const event = completedEvent('nonexistent-order-id', 'cs_test_orphan', { paymentStatus: 'unpaid' });
    const res = await deliver(event);
    // Register before asserting: a non-200 delivery that still persisted the
    // unmatched event must not leak a row no order cleanup can reach.
    const orphan = await db.paymentEvent.findUnique({ where: { providerEventId: event.id } });
    if (orphan) trackPaymentEvent(orphan.id);
    expect(res.status).toBe(200);
    expect(orphan).toMatchObject({ orderId: null, status: 'UNMATCHED', data: { orderId: 'nonexistent-order-id' } });
  });

  it('records a vault-entry failure when an admin marks an order PAID', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({
      vaultAddOn: true,
      stripeSessionId: 'cs_test_manual',
    });
    vaultFault.fail = true;

    const res = await patchOrder(order.id, { status: 'PAID', manualSettlement: {
      method: 'BANK_TRANSFER', reference: 'Controlled receipt', confirmed: true,
    } });
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('Update') });

    const updated = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe('PENDING_PAYMENT');
    expect(updated.paidAt).toBeNull();
    expect(updated.manualSettlement).toBeNull();
    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(0);

    const alerts = await alertsFor(order.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('vault-entry-failed');
    expect(JSON.parse(alerts[0].context!)).toEqual({ operatorId: session.user!.id, outcome: 'unconfirmed' });
  });

  it('records nothing when the vault entry is created successfully', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true });

    const res = await patchOrder(order.id, { status: 'PAID', manualSettlement: {
      method: 'CASH', reference: 'Controlled cash receipt', confirmed: true,
    } });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.not.toHaveProperty('warnings');

    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(1);
    expect(await alertsFor(order.id)).toHaveLength(0);
  });

  it('lists open alerts to admins and refuses everyone else', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });
    await raiseLegacyAlert(order.id);

    await asAdmin();
    const ok = await listAlerts();
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({
      orderId: order.id,
      kind: 'stale-session',
      occurrences: 1,
    });
    expect(body.alerts[0].context).toEqual({
      sessionId: 'cs_test_superseded',
      storedSessionId: 'cs_test_current',
    });
    expect(session.user?.role).toBe('ADMIN');

    const customer = await createUser();
    session.user = { id: customer.id, role: 'USER', email: customer.email };
    expect((await listAlerts()).status).toBe(403);

    session.user = null;
    expect((await listAlerts()).status).toBe(403);
  });

  it('resolves an alert, then reopens it if the same condition recurs', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });
    await raiseLegacyAlert(order.id);
    await asAdmin();

    const [alert] = await alertsFor(order.id);
    const resolved = await patchAlert(alert.id);
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toEqual({ resolved: true });

    const listed = await listAlerts();
    await expect(listed.json()).resolves.toMatchObject({ alerts: [] });
    // Resolving is not permanent suppression of the id.
    expect((await patchAlert(alert.id)).status).toBe(404);

    // A dismissed alert that happens again is still live, so it comes back.
    await raiseLegacyAlert(order.id);
    const reopened = await alertsFor(order.id);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].id).toBe(alert.id);
    expect(reopened[0].resolvedAt).toBeNull();
    expect(reopened[0].occurrences).toBe(2);
  });

  it('refuses to resolve an alert for a caller who is not an admin', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });
    await raiseLegacyAlert(order.id);

    const customer = await createUser();
    session.user = { id: customer.id, role: 'USER', email: customer.email };

    const [alert] = await alertsFor(order.id);
    expect((await patchAlert(alert.id)).status).toBe(403);
    expect((await alertsFor(order.id))[0].resolvedAt).toBeNull();
  });

  it('pages the unresolved event queue so the oldest unmatched event stays reachable', async () => {
    await asAdmin();
    const base = new Date('2026-01-01T00:00:00.000Z');
    const created = [];
    for (let i = 0; i < 3; i++) {
      const row = await db.paymentEvent.create({ data: {
        providerEventId: `evt_page_${i}`, source: 'SIGNED_WEBHOOK', type: 'charge.refunded',
        data: {}, dataDigest: `page-${i}`, status: 'UNMATCHED', objectId: `ch_page_${i}`,
        createdAt: new Date(base.getTime() + i * 1000),
      } });
      trackPaymentEvent(row.id);
      created.push(row);
    }
    const first = await (await listAlerts()).json();
    expect(first.eventCount).toBe(3);
    expect(first.events.map((event: { id: string }) => event.id)).toEqual([
      created[2].id, created[1].id, created[0].id,
    ]);

    // Page past the newest slice using the oldest returned createdAt.
    const cursor = encodeURIComponent(created[1].createdAt.toISOString());
    const older = await (await listAlerts(new Request(`http://localhost/api/admin/payment-alerts?olderThan=${cursor}`))).json();
    expect(older.events.map((event: { id: string }) => event.id)).toEqual([created[0].id]);
    expect(older.eventCount).toBe(1);

    const invalid = await listAlerts(new Request('http://localhost/api/admin/payment-alerts?olderThan=not-a-date'));
    expect(invalid.status).toBe(400);
  });

  it('keeps same-timestamp events reachable through the id tie-breaker', async () => {
    await asAdmin();
    // Both rows share one createdAt, exactly as a single transaction would
    // stamp them; only the id secondary sort keeps the page boundary from
    // skipping a tied sibling.
    const same = new Date('2026-01-02T00:00:00.000Z');
    const tied = [];
    for (const suffix of ['a', 'b']) {
      const row = await db.paymentEvent.create({ data: {
        providerEventId: `evt_tie_${suffix}`, source: 'SIGNED_WEBHOOK', type: 'charge.refunded',
        data: {}, dataDigest: `tie-${suffix}`, status: 'UNMATCHED', objectId: `ch_tie_${suffix}`,
        createdAt: same,
      } });
      trackPaymentEvent(row.id);
      tied.push(row);
    }
    const [newerTied, olderTied] = tied.map(row => row.id).sort().reverse();
    const first = await (await listAlerts()).json();
    expect(first.events.map((event: { id: string }) => event.id)).toEqual([newerTied, olderTied]);

    // The composite cursor pages past the newer tied row to its sibling.
    const query = `olderThan=${encodeURIComponent(same.toISOString())}&olderThanId=${encodeURIComponent(newerTied)}`;
    const older = await (await listAlerts(new Request(`http://localhost/api/admin/payment-alerts?${query}`))).json();
    expect(older.events.map((event: { id: string }) => event.id)).toEqual([olderTied]);
    expect(older.eventCount).toBe(1);

    // The legacy timestamp-only cursor still excludes the whole tie group.
    const legacy = await (await listAlerts(new Request(`http://localhost/api/admin/payment-alerts?olderThan=${encodeURIComponent(same.toISOString())}`))).json();
    expect(legacy.events).toEqual([]);
    expect(legacy.eventCount).toBe(0);

    const orphanId = await listAlerts(new Request(`http://localhost/api/admin/payment-alerts?olderThanId=${encodeURIComponent(newerTied)}`));
    expect(orphanId.status).toBe(400);
  });
});
