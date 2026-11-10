import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db, createUser, cleanupFixtures } from '../fixtures/database';
import { createOrderForUser, type OrderFixtureOverrides } from '../fixtures/orders';
import { POST as pay } from '@/app/api/orders/[id]/pay/route';
import { createCheckoutSession } from '@/lib/stripe';

/**
 * POST /api/orders/[id]/pay is the buyer-facing retry path for an abandoned or
 * failed Checkout, so it is the one place a session id can be re-issued over an
 * existing one. The webhook only honours the stored id, which makes what this
 * route persists the security-relevant part of the flow.
 *
 * Stripe itself is mocked: no test may reach the network, and the real client
 * needs a secret key. isStripeConfigured() is driven by hand so the
 * disabled-Stripe fallback (a deployment without keys must degrade, not crash)
 * is covered too.
 */
const session = vi.hoisted(() => ({
  user: null as null | { id: string; role: string; email: string | null },
}));
vi.mock('@/auth', () => ({ auth: async () => (session.user ? { user: session.user } : null) }));

const stripe = vi.hoisted(() => ({ configured: false, issued: 0, failWith: null as string | null }));
vi.mock('@/lib/stripe', () => ({
  isStripeConfigured: () => stripe.configured,
  createCheckoutSession: vi.fn(async () => {
    if (stripe.failWith) throw new Error(stripe.failWith);
    stripe.issued += 1;
    const sessionId = `cs_test_issued_${stripe.issued}`;
    return { url: `https://checkout.stripe.com/c/${sessionId}`, sessionId };
  }),
}));

const request = (id: string) =>
  new NextRequest(`http://localhost/api/orders/${id}/pay`, { method: 'POST' });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Users created here, so their rate-limit buckets can be cleared explicitly. */
const limiterKeys: string[] = [];

async function createPendingOrder(overrides: OrderFixtureOverrides = {}) {
  const user = await createUser();
  limiterKeys.push(`pay:user:${user.id}`);
  const created = await createOrderForUser(user.id, {
    title: 'Integration Test Book',
    ...overrides,
  });
  return { user, order: created.order };
}

beforeEach(() => {
  stripe.configured = true;
  stripe.issued = 0;
  stripe.failWith = null;
});

afterEach(async () => {
  await cleanupFixtures();
  if (limiterKeys.length) {
    await db.rateLimitBucket.deleteMany({ where: { bucketKey: { in: limiterKeys } } });
    limiterKeys.length = 0;
  }
  vi.unstubAllEnvs();
});

describe('POST /api/orders/[id]/pay', () => {
  it('rejects an unauthenticated caller', async () => {
    const { order } = await createPendingOrder();
    session.user = null;

    const res = await pay(request(order.id), params(order.id));
    expect(res.status).toBe(401);
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects a signed-in caller who is neither the owner nor an admin', async () => {
    const { order } = await createPendingOrder();
    const stranger = await createUser();
    limiterKeys.push(`pay:user:${stranger.id}`);
    session.user = { id: stranger.id, role: 'USER', email: stranger.email };

    const res = await pay(request(order.id), params(order.id));
    expect(res.status).toBe(403);
    expect(createCheckoutSession).not.toHaveBeenCalled();

    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.stripeSessionId).toBeNull();
  });

  it('returns 404 for an order that does not exist', async () => {
    const user = await createUser();
    limiterKeys.push(`pay:user:${user.id}`);
    session.user = { id: user.id, role: 'USER', email: user.email };

    const res = await pay(request('nonexistent-order'), params('nonexistent-order'));
    expect(res.status).toBe(404);
  });

  it('refuses an order that is no longer awaiting payment', async () => {
    const { user, order } = await createPendingOrder({ status: 'PAID' });
    session.user = { id: user.id, role: 'USER', email: user.email };

    const res = await pay(request(order.id), params(order.id));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: 'Order is not awaiting payment (status: PAID)',
    });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });

  it('issues a Checkout session and persists its id against the order', async () => {
    const { user, order } = await createPendingOrder();
    session.user = { id: user.id, role: 'USER', email: user.email };

    const res = await pay(request(order.id), params(order.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkoutUrl).toContain('cs_test_issued_1');

    // The webhook matches the event's session id against this column, so a
    // session that is not stored here could never mark the order paid.
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.stripeSessionId).toBe('cs_test_issued_1');
    expect(stored.status).toBe('PENDING_PAYMENT'); // paying is not the same as paid
    expect(stored.paidAt).toBeNull();

    expect(vi.mocked(createCheckoutSession).mock.calls.at(-1)?.[0]).toMatchObject({
      orderId: order.id,
      submissionTitle: 'Integration Test Book',
      amountHuf: 4000,
      currency: 'HUF',
      customerEmail: user.email,
    });
  });

  it('lets an admin retry payment on someone else\'s order', async () => {
    const { order } = await createPendingOrder();
    const admin = await createUser('ADMIN');
    limiterKeys.push(`pay:user:${admin.id}`);
    session.user = { id: admin.id, role: 'ADMIN', email: admin.email };

    const res = await pay(request(order.id), params(order.id));
    expect(res.status).toBe(200);
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.stripeSessionId).toBe('cs_test_issued_1');
  });

  it('re-issues over a previously stored session id', async () => {
    const { user, order } = await createPendingOrder({ stripeSessionId: 'cs_test_abandoned' });
    session.user = { id: user.id, role: 'USER', email: user.email };

    const res = await pay(request(order.id), params(order.id));
    expect(res.status).toBe(200);

    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.stripeSessionId).toBe('cs_test_issued_1');

    // A second retry replaces it again: exactly one id is ever current, which
    // is what makes the older one "stale" for the reconciliation alert.
    const again = await pay(request(order.id), params(order.id));
    expect(again.status).toBe(200);
    const replaced = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(replaced.stripeSessionId).toBe('cs_test_issued_2');
  });

  it('degrades to 503 when Stripe is not configured, leaving the stored session alone', async () => {
    const { user, order } = await createPendingOrder({ stripeSessionId: 'cs_test_existing' });
    session.user = { id: user.id, role: 'USER', email: user.email };
    stripe.configured = false;

    const res = await pay(request(order.id), params(order.id));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: 'Online payment is not configured for this deployment',
    });
    expect(createCheckoutSession).not.toHaveBeenCalled();

    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.stripeSessionId).toBe('cs_test_existing');
  });

  it('returns 502 and keeps the previous session id when Stripe rejects the request', async () => {
    const { user, order } = await createPendingOrder({ stripeSessionId: 'cs_test_previous' });
    session.user = { id: user.id, role: 'USER', email: user.email };
    stripe.failWith = 'Stripe is having a bad day';

    const res = await pay(request(order.id), params(order.id));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: 'Stripe is having a bad day' });

    // A failed issue must not blank the id: the buyer may still complete the
    // session they already have open.
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.stripeSessionId).toBe('cs_test_previous');
  });

  it('enforces the durable per-user payment rate limit', async () => {
    const { user, order } = await createPendingOrder();
    session.user = { id: user.id, role: 'USER', email: user.email };
    // Disabled Stripe keeps each of the 30 allowed attempts cheap; the limiter
    // is consumed before the configuration check, so the cap is what is under
    // test here rather than session creation.
    stripe.configured = false;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await pay(request(order.id), params(order.id))).status).toBe(503);
    }

    const blocked = await pay(request(order.id), params(order.id));
    expect(blocked.status).toBe(429);
    await expect(blocked.json()).resolves.toEqual({
      error: 'Too many payment attempts - please try again later.',
    });
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
