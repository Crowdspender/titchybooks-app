import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, createUser, cleanupFixtures } from '../fixtures/database';
import { createPendingOrderWithUser } from '../fixtures/orders';
import {
  WEBHOOK_SECRET,
  completedEvent,
  signedEventRequest,
} from '../fixtures/stripe-events';
import { POST as webhook } from '@/app/api/stripe/webhook/route';
import { PATCH as updateOrder } from '@/app/api/admin/orders/[id]/route';
import { GET as listAlerts } from '@/app/api/admin/payment-alerts/route';
import { PATCH as resolveAlert } from '@/app/api/admin/payment-alerts/[id]/route';
import { createVaultEntryForOrder } from '@/lib/orders/lifecycle';

/**
 * Payment reconciliation alerts.
 *
 * The webhook deliberately survives ambiguous events instead of failing them -
 * a signature-verified payment on a superseded session is still honoured, an
 * unpaid completion is dropped - and the admin "mark PAID" path survives a
 * vault-entry failure. Each of those leaves a buyer whose money and goods may
 * disagree, so each one has to produce something an operator can see. A log
 * line does not qualify on serverless hosting; a row in /admin/orders does.
 */
const session = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; email: string | null },
}));
vi.mock('@/auth', () => ({ auth: async () => (session.user ? { user: session.user } : null) }));

// Spied rather than replaced so the webhook keeps the real transition and the
// real vault creation, and only the tests that need a failure inject one.
vi.mock('@/lib/orders/lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orders/lifecycle')>();
  return { ...actual, createVaultEntryForOrder: vi.fn(actual.createVaultEntryForOrder) };
});

beforeAll(() => {
  // getStripeClient() needs *a* key; the handler only verifies signatures, so
  // no network call is made with it.
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_integration_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
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

describe('payment reconciliation alerts', () => {
  it('records the superseded session a real payment arrived on', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });

    const res = await deliver(completedEvent(order.id, 'cs_test_superseded'));
    expect(res.status).toBe(200);

    // The payment is still honoured - the alert is a review prompt, not a block.
    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid.status).toBe('PAID');
    expect(paid.stripeSessionId).toBe('cs_test_current');

    const alerts = await alertsFor(order.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'stale-session',
      occurrences: 1,
      resolvedAt: null,
    });
    expect(JSON.parse(alerts[0].context!)).toEqual({
      sessionId: 'cs_test_superseded',
      storedSessionId: 'cs_test_current',
    });
  });

  it('does not record anything for a payment on the session it was issued for', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_matched' });

    expect((await deliver(completedEvent(order.id, 'cs_test_matched'))).status).toBe(200);
    expect(await alertsFor(order.id)).toHaveLength(0);
  });

  it('collapses Stripe retries of the same event into one alert', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });
    const event = completedEvent(order.id, 'cs_test_superseded');

    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event)).status).toBe(200);

    const alerts = await alertsFor(order.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].occurrences).toBe(3);
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

    const alerts = await alertsFor(order.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('unpaid-completion');
    expect(JSON.parse(alerts[0].context!)).toMatchObject({
      sessionId: 'cs_test_current',
      paymentStatus: 'unpaid',
    });
  });

  it('records an unpaid completion for an order that is no longer stored', async () => {
    // A user only so cleanupFixtures runs: the alert this raises has no order
    // to cascade from, and leaving it behind would surface in later tests.
    await createUser();
    // orderId is a foreign key, so the alert has to be raised without one
    // rather than failing the write the handler is relying on.
    const res = await deliver(
      completedEvent('nonexistent-order-id', 'cs_test_orphan', { paymentStatus: 'unpaid' }),
    );
    expect(res.status).toBe(200);

    const orphan = await db.paymentAlert.findMany({ where: { orderId: null } });
    expect(orphan).toHaveLength(1);
    expect(orphan[0].kind).toBe('unpaid-completion');
    expect(JSON.parse(orphan[0].context!)).toMatchObject({
      referencedOrderId: 'nonexistent-order-id',
    });
  });

  it('records a vault-entry failure when an admin marks an order PAID', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({
      vaultAddOn: true,
      stripeSessionId: 'cs_test_manual',
    });
    vi.mocked(createVaultEntryForOrder).mockRejectedValueOnce(
      new Error('vault table unreachable'),
    );

    const res = await patchOrder(order.id, { status: 'PAID' });
    expect(res.status).toBe(200);
    // The update landed, so the response must not claim an unqualified success.
    await expect(res.json()).resolves.toMatchObject({
      warnings: [expect.stringContaining('vault entry could not be created')],
    });

    const updated = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.status).toBe('PAID');
    expect(updated.paidAt).not.toBeNull();
    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(0);

    const alerts = await alertsFor(order.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe('vault-entry-failed');
    expect(JSON.parse(alerts[0].context!)).toEqual({ error: 'vault table unreachable' });
  });

  it('records nothing when the vault entry is created successfully', async () => {
    await asAdmin();
    const { order } = await createPendingOrderWithUser({ vaultAddOn: true });

    const res = await patchOrder(order.id, { status: 'PAID' });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.not.toHaveProperty('warnings');

    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(1);
    expect(await alertsFor(order.id)).toHaveLength(0);
  });

  it('lists open alerts to admins and refuses everyone else', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });
    await deliver(completedEvent(order.id, 'cs_test_superseded'));

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
    const event = completedEvent(order.id, 'cs_test_superseded');
    await deliver(event);
    await asAdmin();

    const [alert] = await alertsFor(order.id);
    const resolved = await patchAlert(alert.id);
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toEqual({ resolved: true });

    const listed = await listAlerts();
    await expect(listed.json()).resolves.toEqual({ alerts: [] });
    // Resolving is not permanent suppression of the id.
    expect((await patchAlert(alert.id)).status).toBe(404);

    // A dismissed alert that happens again is still live, so it comes back.
    await deliver(event);
    const reopened = await alertsFor(order.id);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].id).toBe(alert.id);
    expect(reopened[0].resolvedAt).toBeNull();
    expect(reopened[0].occurrences).toBe(2);
  });

  it('refuses to resolve an alert for a caller who is not an admin', async () => {
    const { order } = await createPendingOrderWithUser({ stripeSessionId: 'cs_test_current' });
    await deliver(completedEvent(order.id, 'cs_test_superseded'));

    const customer = await createUser();
    session.user = { id: customer.id, role: 'USER', email: customer.email };

    const [alert] = await alertsFor(order.id);
    expect((await patchAlert(alert.id)).status).toBe(403);
    expect((await alertsFor(order.id))[0].resolvedAt).toBeNull();
  });
});
