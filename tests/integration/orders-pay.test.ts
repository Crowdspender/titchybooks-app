import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db, createUser, cleanupFixtures } from '../fixtures/database';
import { createOrderForUser, type OrderFixtureOverrides } from '../fixtures/orders';
import { POST as pay } from '@/app/api/orders/[id]/pay/route';
import { createCheckoutSession, retrieveOrderCheckoutSession } from '@/lib/stripe';
import { syntheticCanonicalProof } from '../fixtures/stripe-events';
import { PAYMENT_RECOVERY_WINDOW_MS } from '@/lib/orders/payment-attempts';
import { randomUUID } from 'node:crypto';
import { buildOffer } from '@/lib/pricing/offer';
import { DEFAULT_RESOLVED_CONFIG } from '@/lib/pricing/constants';
import { SYNTHETIC_SHIPPING_POLICY, syntheticQuoteInputs } from '../fixtures/pricing';

const testPolicy = { ...SYNTHETIC_SHIPPING_POLICY, weightRule: { packagingGrams: 0, vaultCopiesInCustomerParcel: 0 } };
const testConfig = { ...DEFAULT_RESOLVED_CONFIG, version: 1, weightPerBookGrams: 200,
  priceTiers: [{ min: 1, max: 6666, pricePerCopy: 3000 }], shippingTable: { ...DEFAULT_RESOLVED_CONFIG.shippingTable,
    hungary: [{ maxWeightGrams: 40000, priceHuf: 1000 }] } };
vi.mock('@/lib/pricing/config', () => ({ loadCheckoutPricingConfig: async () => testConfig }));

/**
 * POST /api/orders/[id]/pay is the buyer-facing retry path for an abandoned or
 * failed Checkout. All attempts are retained and replacements require canonical
 * terminal proof; known earlier attempts still participate in reconciliation.
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
vi.mock('@/lib/stripe', async original => ({
  ...await original<typeof import('@/lib/stripe')>(),
  stripeLivemode: () => false,
  retrieveStripeAccountContext: vi.fn(async () => ({ accountId: 'acct_fixture', livemode: false })),
  isStripeConfigured: () => stripe.configured,
  createCheckoutSession: vi.fn(async () => {
    if (stripe.failWith) throw new Error(stripe.failWith);
    stripe.issued += 1;
    const sessionId = `cs_test_issued_${stripe.issued}`;
    return { url: `https://checkout.stripe.com/c/${sessionId}`, sessionId };
  }),
  retrieveOrderCheckoutSession: vi.fn(async (id: string, orderId: string) => ({
    id, client_reference_id: orderId, metadata: { orderId }, mode: 'payment', livemode: false,
    currency: 'huf', amount_total: 400000, status: 'expired', payment_status: 'unpaid', url: null,
  })),
}));

vi.mock('@/lib/orders/payment-provider', async original => ({ ...await original<typeof import('@/lib/orders/payment-provider')>(),
  readCanonicalAttempt: async (attempt: import('@prisma/client').PaymentAttempt) => syntheticCanonicalProof(attempt,
    await retrieveOrderCheckoutSession(attempt.sessionId!, attempt.orderId, attempt.currency as 'HUF' | 'EUR' | 'GBP')),
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
  const input = { ...syntheticQuoteInputs(created.order.submissionId), quantity: 1, currency: 'HUF' as const };
  const offer = buildOffer(user.id, input, testConfig, testPolicy);
  const order = await db.order.update({ where: { id: created.order.id }, data: {
    zone: 'hungary', paymentState: 'UNPAID', quoteSnapshot: JSON.parse(JSON.stringify(offer)), expectedMinorAmount: offer.charge.amountMinor,
    fxRate: offer.charge.fxRate, quoteAcceptedAt: new Date(), requestKey: randomUUID(), requestDigest: 'synthetic-test-digest',
  } });
  return { user, order };
}

beforeEach(() => {
  stripe.configured = true;
  stripe.issued = 0;
  stripe.failWith = null;
  vi.mocked(retrieveOrderCheckoutSession).mockReset().mockImplementation(async (id, orderId) => ({
    id, client_reference_id: orderId, metadata: { orderId }, mode: 'payment', livemode: false,
    currency: 'huf', amount_total: 400000, status: 'expired', payment_status: 'unpaid', url: null,
  }) as unknown as Awaited<ReturnType<typeof retrieveOrderCheckoutSession>>);
  vi.stubEnv('ORDER_SHIPPING_POLICY_JSON', JSON.stringify(testPolicy));
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

    // The issued session is retained on its durable attempt as well as Order.
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.stripeSessionId).toBe('cs_test_issued_1');
    expect(stored.status).toBe('PENDING_PAYMENT'); // paying is not the same as paid
    expect(stored.paidAt).toBeNull();

    expect(vi.mocked(createCheckoutSession).mock.calls.at(-1)?.[0]).toMatchObject({
      orderId: order.id,
      amountMinor: 400000,
      currency: 'HUF',
      providerRequest: expect.objectContaining({ customer_email: user.email }),
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

    // A canonically expired session can be replaced, while all earlier records remain.
    const again = await pay(request(order.id), params(order.id));
    expect(again.status).toBe(200);
    const replaced = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(replaced.stripeSessionId).toBe('cs_test_issued_2');
    expect(await db.paymentAttempt.count({ where: { orderId: order.id } })).toBe(3);
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
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining('accepted amount is unchanged') });

    // A failed issue must not blank the id: the buyer may still complete the
    // session they already have open.
    const stored = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.stripeSessionId).toBe('cs_test_previous');
  });

  it('recovers an ambiguous provider call using the identical durable request and key', async () => {
    const { user, order } = await createPendingOrder();
    session.user = { id: user.id, role: 'USER', email: user.email };
    stripe.failWith = 'Synthetic timeout after unknown provider outcome';
    expect((await pay(request(order.id), params(order.id))).status).toBe(502);
    const first = await db.paymentAttempt.findFirstOrThrow({ where: { orderId: order.id } });
    expect(first).toMatchObject({ status: 'AMBIGUOUS', sessionId: null, requestStartedAt: expect.any(Date) });
    stripe.failWith = null;
    await db.submission.update({ where: { id: order.submissionId }, data: { title: 'Changed title after ambiguity' } });
    expect((await pay(request(order.id), params(order.id))).status).toBe(200);
    const calls = vi.mocked(createCheckoutSession).mock.calls;
    expect(calls[0][0].providerRequest).toEqual(calls[1][0].providerRequest);
    expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
    expect(await db.paymentAttempt.count({ where: { orderId: order.id } })).toBe(1);
    expect(retrieveOrderCheckoutSession).not.toHaveBeenCalled();
  });
  it('holds an ambiguity past the safe idempotency window without another provider issue', async () => {
    const { user, order } = await createPendingOrder();
    session.user = { id: user.id, role: 'USER', email: user.email };
    stripe.failWith = 'Synthetic timeout';
    const { preparePaymentAttempt } = await import('@/lib/orders/payment-attempts');
    const prepared = await preparePaymentAttempt(order.id, 'Book', user.email);
    await db.paymentAttempt.update({ where: { id: prepared.id }, data: { status: 'AMBIGUOUS',
      requestStartedAt: new Date(Date.now() - PAYMENT_RECOVERY_WINDOW_MS - 10000) } });
    expect((await pay(request(order.id), params(order.id))).status).toBe(409);
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ paymentHold: true, paymentState: 'REVIEW' });
  });
  it.each([{ status: 'complete', payment_status: 'paid', state: 'PAID' }, { status: 'complete', payment_status: 'unpaid', state: 'PROCESSING' }])('confirms canonical %j without issuing another charge', async patch => {
    const { user, order } = await createPendingOrder({ stripeSessionId: 'cs_test_existing' });
    session.user = { id: user.id, role: 'USER', email: user.email };
    vi.mocked(retrieveOrderCheckoutSession).mockResolvedValue({ id: 'cs_test_existing', client_reference_id: order.id, metadata: { orderId: order.id },
      mode: 'payment', livemode: false, currency: 'huf', amount_total: 400000, url: null, ...patch,
    } as unknown as Awaited<ReturnType<typeof retrieveOrderCheckoutSession>>);
    const response = await pay(request(order.id), params(order.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checkoutUrl: null, paymentState: patch.state });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
  it('does not redirect held orders or trust a downgraded administrator claim', async () => {
    const { order } = await createPendingOrder();
    const admin = await createUser('ADMIN');
    session.user = { id: admin.id, role: 'ADMIN', email: admin.email };
    await db.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
    expect((await pay(request(order.id), params(order.id))).status).toBe(403);
    session.user = { id: order.userId, role: 'USER', email: null };
    await db.order.update({ where: { id: order.id }, data: { paymentHold: true } });
    expect((await pay(request(order.id), params(order.id))).status).toBe(409);
    expect(createCheckoutSession).not.toHaveBeenCalled();
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
