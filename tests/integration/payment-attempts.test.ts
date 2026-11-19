import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, cleanupFixtures } from '../fixtures/database';
import { createPendingOrderWithUser } from '../fixtures/orders';
import { issuePaymentAttempt, preparePaymentAttempt, PAYMENT_RECOVERY_WINDOW_MS } from '@/lib/orders/payment-attempts';
import { CheckoutSessionUnavailable } from '@/lib/stripe';

const provider = vi.hoisted(() => ({ account: vi.fn(), create: vi.fn(), retrieve: vi.fn() }));
vi.mock('@/lib/stripe', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/stripe')>(),
  retrieveStripeAccountContext: provider.account,
  createCheckoutSession: provider.create,
  retrieveOrderCheckoutSession: provider.retrieve,
}));
let serial = 0;
const issued = new Map<string, string>();
beforeEach(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_local_only');
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3100');
  provider.account.mockResolvedValue({ accountId: 'acct_synthetic', livemode: false });
  provider.create.mockImplementation(async input => {
    // Read through a different Prisma client: issuance must have committed first.
    const saved = await db.paymentAttempt.findUniqueOrThrow({ where: { id: input.attemptId } });
    expect(saved.status).toBe('AMBIGUOUS');
    expect(saved.requestStartedAt).not.toBeNull();
    expect(saved.providerAccountId).toBe('acct_synthetic');
    expect(input.providerRequest).toEqual(saved.providerRequest);
    const id = issued.get(input.idempotencyKey) ?? `cs_test_attempt_${++serial}`;
    issued.set(input.idempotencyKey, id);
    return { sessionId: id, url: `https://checkout.stripe.com/synthetic/${id}` };
  });
  provider.retrieve.mockImplementation(async id => ({ id, status: 'open', payment_status: 'unpaid', amount_total: 2740,
    url: `https://checkout.stripe.com/synthetic/${id}` }));
});
afterEach(async () => { await cleanupFixtures(); vi.unstubAllEnvs(); vi.resetAllMocks(); issued.clear(); });
async function fixture() {
  const created = await createPendingOrderWithUser({ currency: 'EUR' });
  await db.order.update({ where: { id: created.order.id }, data: { expectedMinorAmount: 2740, paymentState: 'UNPAID' } });
  return created;
}
it('serializes concurrent preparation into one immutable request before any provider access', async () => {
  const { order } = await fixture();
  const attempts = await Promise.all(Array.from({ length: 6 }, () => preparePaymentAttempt(order.id, 'Émilie', 'synthetic@example.invalid')));
  expect(new Set(attempts.map(a => a.id)).size).toBe(1);
  expect(await db.paymentAttempt.count({ where: { orderId: order.id } })).toBe(1);
  expect(provider.account).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
  expect(attempts[0].providerRequest).toMatchObject({ metadata: { orderId: order.id, attemptId: attempts[0].id },
    payment_intent_data: { metadata: { orderId: order.id, attemptId: attempts[0].id } } });
});
it('publishes one session and reuses an open attempt without creating another charge', async () => {
  const { order } = await fixture(); const attempt = await preparePaymentAttempt(order.id, 'Émilie');
  const first = await issuePaymentAttempt(attempt.id);
  const again = await issuePaymentAttempt((await preparePaymentAttempt(order.id, 'Changed title')).id);
  expect(again).toEqual(first); expect(provider.create).toHaveBeenCalledTimes(1);
  expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ stripeSessionId: first.sessionId, status: 'PENDING_PAYMENT', paidAt: null });
});
it('recovers ambiguous errors with identical frozen parameters and provider key', async () => {
  const { order } = await fixture(); const attempt = await preparePaymentAttempt(order.id, 'Original Émilie', 'synthetic@example.invalid');
  provider.create.mockRejectedValueOnce(new Error('Synthetic timeout; provider may have accepted'));
  await expect(issuePaymentAttempt(attempt.id)).rejects.toThrow('Synthetic timeout');
  const failed = await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
  expect(failed.status).toBe('AMBIGUOUS'); expect(failed.sessionId).toBeNull();
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3999');
  expect((await preparePaymentAttempt(order.id, 'Changed title', 'changed@example.invalid')).id).toBe(attempt.id);
  await issuePaymentAttempt(attempt.id);
  expect(provider.create.mock.calls[0][0]).toEqual(provider.create.mock.calls[1][0]);
  expect((await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).requestStartedAt).toEqual(failed.requestStartedAt);
});
it('concurrent provider issuance uses the same key and records one session', async () => {
  const { order } = await fixture(); const attempt = await preparePaymentAttempt(order.id, 'Émilie');
  const result = await Promise.all(Array.from({ length: 4 }, () => issuePaymentAttempt(attempt.id)));
  expect(new Set(result.map(r => r.sessionId)).size).toBe(1);
  expect(new Set(provider.create.mock.calls.map(c => c[0].idempotencyKey)).size).toBe(1);
  expect(await db.paymentAttempt.count({ where: { orderId: order.id } })).toBe(1);
});
it('blocks an ambiguous recovery beyond the safe key-retention window', async () => {
  const { order } = await fixture(); const attempt = await preparePaymentAttempt(order.id, 'Émilie');
  await db.paymentAttempt.update({ where: { id: attempt.id }, data: { requestStartedAt: new Date(Date.now() - PAYMENT_RECOVERY_WINDOW_MS - 1), status: 'AMBIGUOUS' } });
  await expect(issuePaymentAttempt(attempt.id)).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  expect(provider.account).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
  expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ paymentHold: true, paymentState: 'REVIEW' });
});
it('blocks changed provider account without reissuing', async () => {
  const { order } = await fixture(); const attempt = await preparePaymentAttempt(order.id, 'Émilie');
  await db.paymentAttempt.update({ where: { id: attempt.id }, data: { providerAccountId: 'acct_original' } });
  await expect(issuePaymentAttempt(attempt.id)).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  expect(provider.create).not.toHaveBeenCalled();
});
it('blocks account-mode changes and unknown original amounts', async () => {
  const { order } = await fixture(); const attempt = await preparePaymentAttempt(order.id, 'Émilie');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_synthetic_not_a_real_key');
  await expect(issuePaymentAttempt(attempt.id)).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_local_only');
  const unknown = await createPendingOrderWithUser();
  await expect(preparePaymentAttempt(unknown.order.id, 'Émilie')).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  expect(provider.create).not.toHaveBeenCalled();
});
it('requires canonical import for a pre-migration session and proof for terminal attempts', async () => {
  const { order } = await fixture();
  await db.order.update({ where: { id: order.id }, data: { stripeSessionId: 'cs_test_legacy' } });
  await expect(preparePaymentAttempt(order.id, 'Émilie')).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  await db.order.update({ where: { id: order.id }, data: { stripeSessionId: null } });
  const attempt = await preparePaymentAttempt(order.id, 'Émilie');
  await db.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } });
  await expect(preparePaymentAttempt(order.id, 'Émilie')).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
});
it('retains issued history when cancellation races the provider response', async () => {
  const { order } = await fixture(); const attempt = await preparePaymentAttempt(order.id, 'Émilie');
  provider.create.mockImplementationOnce(async () => {
    await db.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    return { sessionId: 'cs_test_cancellation_race', url: 'https://checkout.stripe.com/synthetic' };
  });
  await expect(issuePaymentAttempt(attempt.id)).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  expect(await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ sessionId: 'cs_test_cancellation_race' });
  expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: 'CANCELLED', stripeSessionId: null });
});
it('retains a session without a URL and prevents blind reissue', async () => {
  const { order } = await fixture(); const attempt = await preparePaymentAttempt(order.id, 'Émilie');
  provider.create.mockRejectedValueOnce(new CheckoutSessionUnavailable('cs_test_without_url'));
  await expect(issuePaymentAttempt(attempt.id)).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  expect(await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: 'REVIEW', sessionId: 'cs_test_without_url' });
  await expect(preparePaymentAttempt(order.id, 'Émilie')).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
});
it('does not reissue an unknown pre-migration request even when its amount is known', async () => {
  const created = await createPendingOrderWithUser({ currency: 'EUR' });
  await db.order.update({ where: { id: created.order.id }, data: { expectedMinorAmount: 2740 } });
  await expect(preparePaymentAttempt(created.order.id, 'Émilie')).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  expect(provider.create).not.toHaveBeenCalled();
});
it('increments the reconciliation revision on an ambiguous failure', async () => {
  const { order } = await fixture(); const attempt = await preparePaymentAttempt(order.id, 'Émilie');
  const revision = (await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentRevision;
  provider.account.mockRejectedValueOnce(new Error('Synthetic account timeout'));
  await expect(issuePaymentAttempt(attempt.id)).rejects.toThrow();
  expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentRevision).toBeGreaterThan(revision + 1);
});
