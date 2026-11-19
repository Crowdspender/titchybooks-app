import { beforeEach, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import type { PaymentAttempt } from '@prisma/client';
import { readCanonicalAttempt, providerPages, discoverAttemptSessions } from '@/lib/orders/payment-provider';
import { projectPayment } from '@/lib/orders/payment-state';
const sdk = vi.hoisted(() => ({ sessions: { retrieve: vi.fn(), list: vi.fn() }, intents: { retrieve: vi.fn() },
  charges: { list: vi.fn(), retrieve: vi.fn() }, refunds: { list: vi.fn() }, disputes: { list: vi.fn() } }));
vi.mock('@/lib/stripe', () => ({ getStripeClient: () => ({ checkout: { sessions: sdk.sessions }, paymentIntents: sdk.intents,
  charges: sdk.charges, refunds: sdk.refunds, disputes: sdk.disputes }) }));
const context = { accountId: 'acct_one', livemode: false };
const attempt: PaymentAttempt = { id: 'attempt_one', orderId: 'order_one', sequence: 1, idempotencyKey: 'order:one:initial',
  expectedMinorAmount: 2740, currency: 'EUR', livemode: false, providerAccountId: 'acct_one', providerRequest: {},
  status: 'OPEN', sessionId: 'cs_one', paymentIntentId: null, requestStartedAt: new Date(), providerSnapshot: null,
  failureCode: null, createdAt: new Date(), updatedAt: new Date() };
let session: Stripe.Checkout.Session, intent: Stripe.PaymentIntent, charge: Stripe.Charge;
beforeEach(() => {
  vi.resetAllMocks();
  session = { id: 'cs_one', mode: 'payment', livemode: false, metadata: { orderId: 'order_one', attemptId: 'attempt_one' },
    client_reference_id: 'order_one', currency: 'eur', amount_total: 2740, amount_subtotal: 2740,
    automatic_tax: { enabled: false }, total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 },
    payment_intent: 'pi_one', payment_status: 'paid', status: 'complete' } as unknown as Stripe.Checkout.Session;
  intent = { id: 'pi_one', livemode: false, metadata: { orderId: 'order_one', attemptId: 'attempt_one' }, amount: 2740,
    amount_received: 2740, currency: 'eur', status: 'succeeded', latest_charge: 'ch_one' } as unknown as Stripe.PaymentIntent;
  charge = { id: 'ch_one', payment_intent: 'pi_one', currency: 'eur', livemode: false, paid: true, captured: true,
    status: 'succeeded', amount_captured: 2740, amount_refunded: 0, disputed: false } as Stripe.Charge;
  sdk.sessions.retrieve.mockImplementation(async () => ({ ...session })); sdk.sessions.list.mockResolvedValue({ data: [], has_more: false });
  sdk.intents.retrieve.mockImplementation(async () => ({ ...intent }));
  sdk.charges.list.mockImplementation(async () => ({ data: [{ ...charge }], has_more: false }));
  sdk.charges.retrieve.mockImplementation(async () => ({ ...charge }));
  sdk.refunds.list.mockResolvedValue({ data: [], has_more: false }); sdk.disputes.list.mockResolvedValue({ data: [], has_more: false });
});
async function projection(patch: Partial<PaymentAttempt> = {}, ctx = context) {
  const proof = await readCanonicalAttempt({ ...attempt, ...patch }, ctx);
  return projectPayment({ expectedMinorAmount: 2740, currency: 'EUR', fulfillment: 'PENDING_PAYMENT', hasManualSettlement: false }, [proof]);
}
it('proves session, intent, captured total, exact charge and account before settlement', async () => {
  expect(await projection()).toMatchObject({ state: 'PAID', hold: false, canSettle: true, summary: { receivedMinor: 2740 } });
  expect(sdk.charges.list).toHaveBeenCalledWith({ payment_intent: 'pi_one', limit: 100, starting_after: undefined });
});
it.each([
  ['session identity', () => { session.id = 'cs_other'; }], ['order reference', () => { session.client_reference_id = 'other'; }],
  ['attempt reference', () => { session.metadata = { orderId: 'order_one', attemptId: 'other' }; }],
  ['subscription', () => { session.mode = 'subscription'; }], ['mode', () => { session.livemode = true; }],
  ['currency', () => { session.currency = 'gbp'; }], ['amount', () => { session.amount_total = 2800; }],
  ['tax', () => { session.automatic_tax!.enabled = true; }],
  ['discount', () => { session.total_details!.amount_discount = 100; }],
  ['intent identity', () => { intent.id = 'pi_other'; }], ['intent metadata', () => { intent.metadata = {}; }],
  ['intent mode', () => { intent.livemode = true; }], ['intent amount', () => { intent.amount = 2800; }],
  ['captured underpayment', () => { intent.amount_received = 2600; }], ['charge reference', () => { charge.payment_intent = 'pi_other'; }],
  ['charge currency', () => { charge.currency = 'gbp'; }], ['charge mode', () => { charge.livemode = true; }],
  ['unconfirmed capture', () => { charge.captured = false; }], ['latest charge', () => { intent.latest_charge = 'ch_missing'; }],
] as const)('holds canonical %s mismatches without settlement', async (_name, mutate) => {
  mutate(); expect(await projection()).toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
});
it('holds account mismatch and changed persisted PaymentIntent references', async () => {
  expect(await projection({}, { ...context, accountId: 'acct_other' })).toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
  expect(await projection({ paymentIntentId: 'pi_previous' })).toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
});
it('supports legacy proofs without inventing new attempt metadata', async () => {
  session.metadata = { orderId: 'order_one' }; intent.metadata = { orderId: 'order_one' };
  expect(await projection({ providerRequest: { origin: 'LEGACY_STRIPE_SESSION' } })).toMatchObject({ state: 'PAID', canSettle: true });
});
it.each(['processing', 'requires_payment_method', 'canceled'] as const)('does not settle async %s', async status => {
  session.payment_status = 'unpaid'; intent.status = status; intent.amount_received = 0; intent.latest_charge = null;
  sdk.charges.list.mockResolvedValue({ data: [], has_more: false });
  expect(await projection()).toMatchObject({ canSettle: false });
});
it('does not replace an open recoverable async session with another charge', async () => {
  session.status = 'open'; session.payment_status = 'unpaid'; intent.status = 'requires_payment_method'; intent.amount_received = 0;
  intent.latest_charge = null; sdk.charges.list.mockResolvedValue({ data: [], has_more: false });
  expect(await projection()).toMatchObject({ state: 'UNPAID', hold: false });
});
it('retains canonical pending, failed and completed refunds across every page', async () => {
  const refund = { id: 're_one', charge: 'ch_one', payment_intent: 'pi_one', currency: 'eur', amount: 1000, status: 'succeeded' };
  sdk.refunds.list.mockImplementation(async ({ starting_after }) => starting_after
    ? { data: [{ ...refund, id: 're_pending', amount: 100, status: 'pending' }, { ...refund, id: 're_failed', amount: 200, status: 'failed' }], has_more: false }
    : { data: [refund], has_more: true });
  charge.amount_refunded = 1000;
  expect(await projection()).toMatchObject({ state: 'PARTIALLY_REFUNDED', hold: true,
    summary: { refundedMinor: 1000, pendingRefundMinor: 100, failedRefundMinor: 200, netReceivedMinor: 1740 } });
  expect(sdk.refunds.list).toHaveBeenCalledWith({ charge: 'ch_one', limit: 100, starting_after: 're_one' });
});
it('validates refund and dispute provider references rather than trusting delivered amounts', async () => {
  sdk.refunds.list.mockResolvedValue({ data: [{ id: 're_one', charge: 'ch_other', payment_intent: 'pi_other', currency: 'eur', amount: 1000, status: 'failed' }], has_more: false });
  sdk.disputes.list.mockResolvedValue({ data: [{ id: 'dp_one', charge: 'ch_other', payment_intent: 'pi_other', livemode: true, currency: 'eur', amount: 2740, status: 'won' }], has_more: false });
  expect(await projection()).toMatchObject({ state: 'REVIEW', hold: true, canSettle: false });
});
it.each(['needs_response', 'won', 'lost'] as const)('canonically reconciles a %s dispute', async status => {
  charge.disputed = true;
  sdk.disputes.list.mockResolvedValue({ data: [{ id: 'dp_one', charge: 'ch_one', payment_intent: 'pi_one', livemode: false, currency: 'eur', amount: 2740, status }], has_more: false });
  expect(await projection()).toMatchObject({ state: status === 'won' ? 'PAID' : status === 'lost' ? 'DISPUTE_LOST' : 'DISPUTED', hold: status !== 'won' });
});
it('rejects incomplete/changing snapshots instead of publishing partial refunds', async () => {
  charge.amount_refunded = 100;
  await expect(projection()).rejects.toThrow('Canonical provider state changed');
});
it('detects intent/session changes during canonical retrieval', async () => {
  sdk.intents.retrieve.mockResolvedValueOnce(intent).mockResolvedValueOnce({ ...intent, status: 'processing' });
  await expect(projection()).rejects.toThrow('Canonical provider state changed');
});
it('recovers an unpublished session through paginated recorded metadata', async () => {
  sdk.sessions.list.mockResolvedValueOnce({ data: [{ ...session, id: 'unrelated', metadata: {} }], has_more: true })
    .mockResolvedValueOnce({ data: [session], has_more: false });
  expect((await readCanonicalAttempt({ ...attempt, sessionId: null }, context)).sessionId).toBe('cs_one');
  expect(sdk.sessions.list.mock.calls[1][0].starting_after).toBe('unrelated');
});
it('retains ambiguous absence and multiple issued-session outcomes for review', async () => {
  expect(await projection({ sessionId: null, status: 'AMBIGUOUS' })).toMatchObject({ state: 'REVIEW', hold: true });
  sdk.sessions.list.mockResolvedValue({ data: [session, { ...session, id: 'cs_two' }], has_more: false });
  expect((await readCanonicalAttempt({ ...attempt, sessionId: null }, context)).reviewReasons).toContain('multiple-issued-sessions');
});
it('does not access the provider for an unstarted attempt discovery', async () => {
  expect(await discoverAttemptSessions({ ...attempt, requestStartedAt: null })).toEqual([]);
  expect(sdk.sessions.list).not.toHaveBeenCalled();
});
it('fails closed on repeated cursors, empty unfinished pages and page bounds', async () => {
  await expect(providerPages(async () => ({ data: [], has_more: true }))).rejects.toThrow('Incomplete provider pagination');
  await expect(providerPages(async () => ({ data: [{ id: 'same' }], has_more: true }))).rejects.toThrow('Incomplete provider pagination');
  let index = 0;
  await expect(providerPages(async () => ({ data: [{ id: String(index++) }], has_more: true }))).rejects.toThrow('pagination limit');
});
