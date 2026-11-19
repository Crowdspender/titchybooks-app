import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import type { PaymentAttempt } from '@prisma/client';
import { db, cleanupFixtures, createUser, trackPaymentEvent } from '../fixtures/database';
import { createPendingOrderWithUser } from '../fixtures/orders';
import { preparePaymentAttempt } from '@/lib/orders/payment-attempts';
import { importLegacyPaymentAttempt, reconcileOrderPayment, recordAdminReconciliation, releasePaymentHold } from '@/lib/orders/payment-reconciliation';
import { processSignedPaymentEvent, recordSignedPaymentEvent } from '@/lib/orders/payment-events';
import { applyOrderLifecycle } from '@/lib/orders/lifecycle';
import { ProviderSnapshotChanged } from '@/lib/orders/payment-provider';
import type { CanonicalPaymentProof } from '@/lib/orders/payment-state';
const provider = vi.hoisted(() => ({ read: vi.fn(), legacy: vi.fn(), account: vi.fn(), intent: vi.fn(), charge: vi.fn(), sessions: vi.fn(), fault: false, holdRace: false, holdRaceDone: null as null | Promise<void> }));
vi.mock('@/lib/stripe', async original => ({ ...await original<typeof import('@/lib/stripe')>(),
  retrieveStripeAccountContext: provider.account, retrieveOrderCheckoutSession: provider.legacy,
  getStripeClient: () => ({ checkout: { sessions: { list: provider.sessions } }, paymentIntents: { retrieve: provider.intent }, charges: { retrieve: provider.charge } }),
}));
vi.mock('@/lib/orders/payment-provider', async original => ({ ...await original<typeof import('@/lib/orders/payment-provider')>(), readCanonicalAttempt: provider.read }));
vi.mock('@/lib/prisma', async () => {
  const { db } = await import('../fixtures/database');
  return { prisma: db.$extends({ query: { vaultEntry: { async upsert({ args, query }) {
    const row = await query(args);
    if (provider.fault) { provider.fault = false; throw new Error('Injected post-Vault failure'); }
    return row;
  } }, order: { async update({ args, query }) {
    const row = await query(args);
    // Simulate a newer admin reconciliation hold committing right after this
    // publish: its provider read fails, so the fingerprint stays unchanged.
    if (provider.holdRace && args.data.paymentState !== undefined) {
      provider.holdRace = false;
      // Queue behind this publish's order lock without awaiting it: the separate
      // connection commits right after the publish, ahead of the release lock.
      provider.holdRaceDone = (async () => {
        await db.order.update({ where: { id: args.where.id }, data: { paymentHold: true, paymentRevision: { increment: 1 } } });
        await db.paymentEvent.create({ data: { providerEventId: `admin:holdrace:${Date.now()}`, source: 'ADMIN_RECONCILIATION',
          type: 'canonical.reconciliation', orderId: args.where.id, data: { operatorId: 'race' }, dataDigest: 'holdrace',
          status: 'FAILED', processedAt: new Date(), outcome: 'CANONICAL_RECONCILIATION_FAILED' } });
      })();
    }
    return row;
  } } } }) };
});
const authorization = vi.hoisted(() => ({ auth: vi.fn(), limit: vi.fn() }));
vi.mock('@/auth', () => ({ auth: authorization.auth }));
vi.mock('@/lib/rate-limit', async original => ({ ...await original<typeof import('@/lib/rate-limit')>(), consumeRateLimit: authorization.limit }));
import { GET as paymentHistory, POST as paymentAction } from '@/app/api/admin/orders/[id]/payment/route';
import { GET as paymentQueue } from '@/app/api/admin/payment-alerts/route';
const facts = new Map<string, Partial<CanonicalPaymentProof>>();
let serial = 0;
beforeEach(() => {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_local_only');
  authorization.auth.mockResolvedValue(null);
  authorization.limit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  provider.account.mockResolvedValue({ accountId: 'acct_one', livemode: false });
  provider.read.mockImplementation(async (attempt: PaymentAttempt) => {
    // A separate connection can acquire the order lock during the provider call.
    await db.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${attempt.orderId} FOR UPDATE`; });
    return { attemptId: attempt.id, sessionId: attempt.sessionId, paymentIntentId: `pi_${attempt.id}`,
      expectedAccountId: attempt.providerAccountId, accountId: 'acct_one', expectedLivemode: attempt.livemode,
      livemode: false, expectedMinorAmount: attempt.expectedMinorAmount, amountMinor: attempt.expectedMinorAmount,
      currency: attempt.currency, status: 'SUCCEEDED', receivedMinor: attempt.expectedMinorAmount,
      refunds: [], disputes: [], reviewReasons: [], ...facts.get(attempt.id) } satisfies CanonicalPaymentProof;
  });
  provider.legacy.mockImplementation(async (id: string, orderId: string) => ({ id, amount_total: 2740, livemode: false, metadata: { orderId } }));
  provider.sessions.mockResolvedValue({ data: [], has_more: false });
  provider.intent.mockResolvedValue({ metadata: {} });
});
afterEach(async () => { provider.fault = false; provider.holdRace = false; if (provider.holdRaceDone) { await provider.holdRaceDone; provider.holdRaceDone = null; } facts.clear(); await cleanupFixtures(); vi.unstubAllEnvs(); vi.resetAllMocks(); });
async function fixture(vaultAddOn = true) {
  const created = await createPendingOrderWithUser({ currency: 'EUR', vaultAddOn });
  await db.order.update({ where: { id: created.order.id }, data: { expectedMinorAmount: 2740, paymentState: 'UNPAID' } });
  const prepared = await preparePaymentAttempt(created.order.id, 'Émilie');
  const attempt = await db.paymentAttempt.update({ where: { id: prepared.id }, data: { providerAccountId: 'acct_one', sessionId: `cs_${++serial}`, status: 'OPEN' } });
  await db.order.update({ where: { id: created.order.id }, data: { stripeSessionId: attempt.sessionId } });
  return { ...created, attempt };
}
function event(attempt: PaymentAttempt, patch: Partial<Stripe.Event> = {}): Stripe.Event {
  return { id: `evt_${randomUUID()}`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000), livemode: false,
    data: { object: { object: 'checkout.session', id: attempt.sessionId, metadata: { orderId: attempt.orderId, attemptId: attempt.id },
      payment_status: 'paid', amount_total: 2740, currency: 'eur', customer_email: 'private@example.invalid', customer_details: { name: 'Private Name' } } }, ...patch } as Stripe.Event;
}
async function tracked(event: Stripe.Event) { const saved = await recordSignedPaymentEvent(event); trackPaymentEvent(saved.id); return saved; }
async function state(orderId: string) { return db.order.findUniqueOrThrow({ where: { id: orderId }, include: { vaultEntries: true } }); }
const refund = { id: 're_one', chargeId: 'ch_one', amountMinor: 1000, currency: 'EUR', status: 'succeeded' };
const dispute = { id: 'dp_one', chargeId: 'ch_one', amountMinor: 2740, currency: 'EUR', status: 'needs_response' };
it('atomically confirms canonical payment and one private Vault copy, with durable minimized events', async () => {
  const { order, attempt } = await fixture(); const delivery = event(attempt); await tracked(delivery);
  const processed = await processSignedPaymentEvent(delivery);
  expect(processed.status).toBe('PROCESSED');
  expect(JSON.stringify(processed.data)).not.toMatch(/private@example|Private Name|customer_details|customer_email/);
  const saved = await state(order.id);
  expect(saved).toMatchObject({ status: 'PAID', paymentState: 'PAID', paymentHold: false, paidAt: expect.any(Date) });
  expect(saved.vaultEntries).toHaveLength(1); expect(saved.vaultEntries[0].publicConsent).toBe(false);
});
it('deduplicates simultaneous first signed deliveries and canonical reconciliation without duplicate goods', async () => {
  const { order, attempt } = await fixture(); const delivery = event(attempt);
  // No pre-created event: exercise the initial unique insert race too.
  expect(await db.paymentEvent.count({ where: { providerEventId: delivery.id } })).toBe(0);
  try {
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => processSignedPaymentEvent(delivery)));
    expect(outcomes.map(outcome => outcome.status)).toEqual(Array(6).fill('fulfilled'));
    expect(outcomes.every(outcome => outcome.status === 'fulfilled' && outcome.value.status === 'PROCESSED')).toBe(true);
    expect(await db.paymentEvent.count({ where: { providerEventId: delivery.id } })).toBe(1);
    expect((await state(order.id)).vaultEntries).toHaveLength(1);
    const changed = { ...delivery, data: { object: { ...delivery.data.object, amount_total: 9999 } } } as Stripe.Event;
    await expect(recordSignedPaymentEvent(changed)).rejects.toThrow('identity collision');
  } finally {
    const saved = await db.paymentEvent.findUnique({ where: { providerEventId: delivery.id } });
    if (saved) trackPaymentEvent(saved.id);
  }
});
it('preserves immutable event identity and rejects changed financial data on an existing ID', async () => {
  const { attempt } = await fixture(); const delivery = event(attempt); const saved = await tracked(delivery);
  const changed = { ...delivery, data: { object: { ...delivery.data.object, amount_total: 9999 } } } as Stripe.Event;
  await expect(recordSignedPaymentEvent(changed)).rejects.toThrow('identity collision');
  expect((await db.paymentEvent.findUniqueOrThrow({ where: { id: saved.id } })).data).toEqual(saved.data);
});
it('recovers a historical missing Vault row without rewriting fulfilled status or unknown paidAt', async () => {
  const { order } = await fixture();
  await db.order.update({ where: { id: order.id }, data: { status: 'SHIPPED' } });
  expect((await reconcileOrderPayment(order.id)).settled).toBe(false);
  expect(await state(order.id)).toMatchObject({ status: 'SHIPPED', paidAt: null });
  expect((await state(order.id)).vaultEntries).toHaveLength(1);
});
it('rejects held manual settlement and unstarted production in the lifecycle itself', async () => {
  const { order } = await fixture(); const admin = await createUser('ADMIN');
  await db.order.update({ where: { id: order.id }, data: { paymentHold: true } });
  expect(await db.$transaction(tx => applyOrderLifecycle(tx, order.id, { source: 'admin', operatorId: admin.id, update: {
    status: 'PAID', manualSettlement: { method: 'BANK_TRANSFER', reference: 'Synthetic receipt', confirmed: true },
  } }))).toMatchObject({ ok: false, reason: 'payment-review' });
  await db.order.update({ where: { id: order.id }, data: { status: 'PAID' } });
  expect(await db.$transaction(tx => applyOrderLifecycle(tx, order.id, { source: 'admin', operatorId: admin.id,
    update: { status: 'IN_PRODUCTION' } }))).toMatchObject({ ok: false, reason: 'payment-review' });
  expect((await state(order.id)).vaultEntries).toHaveLength(0);
});
it('keeps a failed canonical fetch durable and holds fulfillment until recovery', async () => {
  const { order, attempt } = await fixture(); const delivery = event(attempt); const saved = await tracked(delivery);
  provider.account.mockRejectedValueOnce(new Error('Synthetic provider timeout'));
  await expect(processSignedPaymentEvent(delivery)).rejects.toThrow('Synthetic provider timeout');
  expect(await state(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paymentHold: true, vaultEntries: [] });
  expect((await db.paymentEvent.findUniqueOrThrow({ where: { id: saved.id } })).status).toBe('FAILED');
  expect((await processSignedPaymentEvent(delivery)).status).toBe('PROCESSED');
});
it('rolls back projection, attempt publication, settlement, Vault and event outcome on a side-effect failure', async () => {
  const { order, attempt } = await fixture(); const delivery = event(attempt); const saved = await tracked(delivery);
  provider.fault = true;
  await expect(processSignedPaymentEvent(delivery)).rejects.toThrow('Injected post-Vault failure');
  expect(await state(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paidAt: null, paymentSummary: null, vaultEntries: [] });
  expect(await db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ providerSnapshot: null, paymentIntentId: null });
  expect((await db.paymentEvent.findUniqueOrThrow({ where: { id: saved.id } })).status).toBe('FAILED');
  await processSignedPaymentEvent(delivery); expect((await state(order.id)).vaultEntries).toHaveLength(1);
});
it.each(['PAID', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED'] as const)('late payments preserve %s and existing paidAt/consent/history', async status => {
  const { order, attempt } = await fixture(); await reconcileOrderPayment(order.id);
  const first = await state(order.id);
  await db.order.update({ where: { id: order.id }, data: { status } });
  const entry = await db.vaultEntry.update({ where: { orderId: order.id }, data: { publicConsent: true, status: 'WITHDRAWN', quantity: 7 } });
  const delivery = event(attempt); await tracked(delivery); await processSignedPaymentEvent(delivery);
  expect(await state(order.id)).toMatchObject({ status, paidAt: first.paidAt });
  expect(await db.vaultEntry.findUniqueOrThrow({ where: { orderId: order.id } })).toEqual(entry);
});
it('does not revive a canceled paid order and retains money for review', async () => {
  const { order, attempt } = await fixture(); await db.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
  const delivery = event(attempt); await tracked(delivery); await processSignedPaymentEvent(delivery);
  expect(await state(order.id)).toMatchObject({ status: 'CANCELLED', paymentState: 'REVIEW', paymentHold: true, vaultEntries: [] });
});
it('allows one known earlier session to settle once but reviews multiple payments', async () => {
  const { order, attempt } = await fixture();
  await db.paymentAttempt.update({ where: { id: attempt.id }, data: { status: 'EXPIRED', providerSnapshot: { status: 'EXPIRED' } } });
  const next = await preparePaymentAttempt(order.id, 'Émilie');
  const latest = await db.paymentAttempt.update({ where: { id: next.id }, data: { providerAccountId: 'acct_one', sessionId: `cs_${++serial}`, status: 'OPEN' } });
  await db.order.update({ where: { id: order.id }, data: { stripeSessionId: latest.sessionId } });
  facts.set(latest.id, { status: 'OPEN', receivedMinor: 0, paymentIntentId: null });
  expect(await reconcileOrderPayment(order.id)).toMatchObject({ state: 'PAID', settled: true });
  facts.delete(latest.id);
  expect(await reconcileOrderPayment(order.id)).toMatchObject({ state: 'REVIEW', hold: true, settled: false, summary: { receivedMinor: 5480 } });
  expect((await state(order.id)).vaultEntries).toHaveLength(1);
});
it.each([
  { amountMinor: 2800 }, { currency: 'GBP' }, { livemode: true }, { accountId: 'acct_other' },
  { reviewReasons: ['session-reference-mismatch'] }, { receivedMinor: 5480 },
] as Array<Partial<CanonicalPaymentProof>>)('holds mismatched canonical facts %j without fulfilling', async patch => {
  const { order, attempt } = await fixture(); facts.set(attempt.id, patch);
  expect(await reconcileOrderPayment(order.id)).toMatchObject({ state: 'REVIEW', hold: true, settled: false });
  expect((await state(order.id)).vaultEntries).toHaveLength(0);
});
it('retains unknown/mismatched signed sessions instead of treating metadata as issuance proof', async () => {
  const { order, attempt } = await fixture();
  const delivery = event(attempt); (delivery.data.object as unknown as Record<string, unknown>).id = 'cs_never_issued';
  await tracked(delivery); expect((await processSignedPaymentEvent(delivery)).status).toBe('REVIEW');
  expect(await state(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paymentHold: true, vaultEntries: [] });
});
it('retains unmatched and unrelated events with no invented order', async () => {
  const { attempt } = await fixture(); const delivery = event(attempt);
  delivery.data.object = { object: 'checkout.session', id: 'cs_unknown', metadata: {}, payment_status: 'paid' } as Stripe.Checkout.Session;
  const saved = await tracked(delivery); expect((await processSignedPaymentEvent(delivery)).status).toBe('UNMATCHED');
  expect((await db.paymentEvent.findUniqueOrThrow({ where: { id: saved.id } })).orderId).toBeNull();
  const unrelated = event(attempt, { type: 'customer.created' }); await tracked(unrelated);
  expect((await processSignedPaymentEvent(unrelated)).status).toBe('IGNORED');
});
it.each(['refund.updated', 'charge.dispute.created'] as const)('associates a legacy %s through the provider intent→session link', async type => {
  const sessionId = `cs_legacy_${++serial}`;
  const { order } = await createPendingOrderWithUser({ currency: 'EUR', stripeSessionId: sessionId });
  const intentId = `pi_legacy_${serial}`;
  // A pre-migration intent carries no order metadata; only the provider's own
  // intent→session list plus our recorded session→order reference can bind it.
  provider.intent.mockResolvedValue({ metadata: {} });
  provider.sessions.mockResolvedValue({ data: [{ id: sessionId }], has_more: false });
  const object = type === 'refund.updated'
    ? { object: 'refund', id: 're_legacy', charge: 'ch_legacy', payment_intent: intentId, amount: 100, currency: 'eur', status: 'succeeded' }
    : { object: 'dispute', id: 'dp_legacy', charge: 'ch_legacy', payment_intent: intentId, amount: 2740, currency: 'eur', status: 'needs_response' };
  const delivery = { id: `evt_${randomUUID()}`, type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object } } as Stripe.Event;
  await tracked(delivery);
  const processed = await processSignedPaymentEvent(delivery);
  expect(processed.orderId).toBe(order.id);
  expect(processed.status).not.toBe('UNMATCHED');
  expect(await state(order.id)).toMatchObject({ paymentHold: true });
});
it('does not clobber a concurrently matched delivery when a later lookup finds nothing', async () => {
  const { order, attempt } = await fixture();
  facts.set(attempt.id, { disputes: [{ id: 'dp_race', chargeId: 'ch_race', amountMinor: 2740, currency: 'EUR', status: 'won' }] });
  const delivery = event(attempt, { type: 'charge.dispute.created' });
  delivery.data.object = { object: 'dispute', id: 'dp_race', payment_intent: `pi_${attempt.id}`, charge: 'ch_race',
    amount: 2740, currency: 'eur', status: 'won' } as Stripe.Dispute;
  let aReady!: () => void; const aGated = new Promise<void>(resolve => { aReady = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  provider.intent.mockImplementationOnce(async () => { aReady(); await gate; return { metadata: {} }; });
  const a = processSignedPaymentEvent(delivery);
  await aGated;
  // A second delivery matches through the now-published intent reference and wins.
  await db.paymentAttempt.update({ where: { id: attempt.id }, data: { paymentIntentId: `pi_${attempt.id}` } });
  const b = await processSignedPaymentEvent(delivery);
  expect(b.status).toBe('PROCESSED');
  release();
  expect(await a).toMatchObject({ status: 'PROCESSED', orderId: order.id });
});
it.each(['pending', 'failed', 'succeeded'] as const)('canonically projects %s refunds without event-delivery increments', async status => {
  const { order, attempt } = await fixture(); await reconcileOrderPayment(order.id); const before = await state(order.id);
  facts.set(attempt.id, { refunds: [{ ...refund, status }] });
  const first = await reconcileOrderPayment(order.id), second = await reconcileOrderPayment(order.id);
  expect(first.summary).toEqual(second.summary); expect(second.hold).toBe(true);
  expect(second.summary.refundedMinor).toBe(status === 'succeeded' ? 1000 : 0);
  expect(await state(order.id)).toMatchObject({ status: 'PAID', paidAt: before.paidAt });
  expect((await state(order.id)).vaultEntries).toHaveLength(1);
});
it('keeps full-refund and lost-dispute state separate from shipped goods', async () => {
  const { order, attempt } = await fixture(); await reconcileOrderPayment(order.id);
  await db.order.update({ where: { id: order.id }, data: { status: 'SHIPPED' } });
  facts.set(attempt.id, { refunds: [{ ...refund, amountMinor: 2740 }] });
  expect(await reconcileOrderPayment(order.id)).toMatchObject({ state: 'REFUNDED', hold: true });
  facts.set(attempt.id, { disputes: [{ ...dispute, status: 'lost' }] });
  expect(await reconcileOrderPayment(order.id)).toMatchObject({ state: 'DISPUTE_LOST', hold: true });
  expect(await state(order.id)).toMatchObject({ status: 'SHIPPED' }); expect((await state(order.id)).vaultEntries).toHaveLength(1);
});
it('blocks production on a dispute and releases only won or explicitly reviewed unchanged facts', async () => {
  const { order, attempt } = await fixture(); const admin = await createUser('ADMIN'); await reconcileOrderPayment(order.id);
  facts.set(attempt.id, { disputes: [dispute] }); const held = await reconcileOrderPayment(order.id);
  await expect(db.order.update({ where: { id: order.id }, data: { status: 'IN_PRODUCTION' } })).rejects.toThrow('Payment review');
  await releasePaymentHold(order.id, admin.id, held.summary.fingerprint, 'Finance reviewed this dispute and approved fulfillment.');
  expect((await reconcileOrderPayment(order.id)).hold).toBe(false);
  facts.set(attempt.id, { disputes: [{ ...dispute, status: 'under_review' }] });
  expect((await reconcileOrderPayment(order.id)).hold).toBe(true);
  facts.set(attempt.id, { disputes: [{ ...dispute, status: 'won' }] });
  expect((await reconcileOrderPayment(order.id)).hold).toBe(false);
});
it('rejects stale review fingerprints and records the real operator', async () => {
  const { order, attempt } = await fixture(); const admin = await createUser('ADMIN'); await reconcileOrderPayment(order.id);
  facts.set(attempt.id, { refunds: [refund] }); const held = await reconcileOrderPayment(order.id);
  facts.set(attempt.id, { refunds: [{ ...refund, amountMinor: 2000 }] });
  await expect(releasePaymentHold(order.id, admin.id, held.summary.fingerprint, 'Reviewed unchanged refund.')).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  const latest = await reconcileOrderPayment(order.id);
  await releasePaymentHold(order.id, admin.id, latest.summary.fingerprint, 'Finance approved fulfillment despite the partial refund.');
  expect((await db.paymentEvent.findFirstOrThrow({ where: { orderId: order.id, source: 'ADMIN_REVIEW' } })).data).toMatchObject({ operatorId: admin.id });
});
it('retries a stale database revision and changing provider snapshots', async () => {
  const { order } = await fixture(); const implementation = provider.read.getMockImplementation()!;
  provider.read.mockImplementationOnce(async (...args) => { await db.order.update({ where: { id: order.id }, data: { paymentRevision: { increment: 1 } } }); return implementation(...args); });
  expect((await reconcileOrderPayment(order.id)).settled).toBe(true); expect(provider.read).toHaveBeenCalledTimes(2);
  provider.read.mockRejectedValueOnce(new ProviderSnapshotChanged());
  expect((await reconcileOrderPayment(order.id)).state).toBe('PAID');
});
it('records failed/successful admin reconciliation and keeps legacy unknown payment facts unknown', async () => {
  const { order } = await createPendingOrderWithUser({ status: 'SHIPPED' }); const admin = await createUser('ADMIN');
  expect((await recordAdminReconciliation(order.id, admin.id)).state).toBeNull();
  provider.account.mockRejectedValueOnce(new Error('Synthetic unavailable account'));
  await expect(recordAdminReconciliation(order.id, admin.id)).rejects.toThrow('Synthetic unavailable account');
  expect((await db.paymentEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } })).map(e => e.status)).toEqual(['PROCESSED', 'FAILED']);
  expect(await state(order.id)).toMatchObject({ status: 'SHIPPED', expectedMinorAmount: null, paidAt: null, fxRate: null, quoteAcceptedAt: null });
});
it('imports only a canonically proved legacy amount and preserves historical FX/paidAt', async () => {
  const { order } = await createPendingOrderWithUser({ currency: 'EUR', stripeSessionId: `cs_legacy_${++serial}`, status: 'SHIPPED' });
  const imported = await importLegacyPaymentAttempt(order.id);
  expect(imported).toMatchObject({ expectedMinorAmount: 2740, providerRequest: { origin: 'LEGACY_STRIPE_SESSION', request: null } });
  expect(await importLegacyPaymentAttempt(order.id)).toEqual(imported);
  expect(await state(order.id)).toMatchObject({ expectedMinorAmount: 2740, fxRate: null, paidAt: null, quoteAcceptedAt: null, status: 'SHIPPED' });
});
it.each([
  ['wrong mode', { livemode: true }], ['wrong account', { account: 'acct_other' }],
  ['wrong amount', { data: { amount_total: 2800 } }], ['wrong currency', { data: { currency: 'gbp' } }],
  ['wrong attempt', { data: { metadata: { orderId: 'other', attemptId: 'other' } } }],
] as const)('holds %s signed-delivery mismatches even if canonical payment is otherwise valid', async (_name, patch) => {
  const { order, attempt } = await fixture(); const delivery = event(attempt);
  if ('data' in patch) delivery.data.object = { ...delivery.data.object, ...patch.data } as Stripe.Checkout.Session;
  else Object.assign(delivery, patch);
  await tracked(delivery); expect((await processSignedPaymentEvent(delivery)).status).toBe('REVIEW');
  expect(await state(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paymentHold: true, vaultEntries: [] });
});
it('uses canonical async success despite an older unpaid completion delivery', async () => {
  const { order, attempt } = await fixture(); const delivery = event(attempt);
  (delivery.data.object as Stripe.Checkout.Session).payment_status = 'unpaid';
  await tracked(delivery); await processSignedPaymentEvent(delivery);
  expect(await state(order.id)).toMatchObject({ status: 'PAID', paymentState: 'PAID', paymentHold: false });
});
it('reconciles refund/dispute deliveries from canonical details without repeating adjustments', async () => {
  const { order, attempt } = await fixture(); await reconcileOrderPayment(order.id);
  facts.set(attempt.id, { refunds: [refund], disputes: [dispute] });
  const delivery = event(attempt, { type: 'charge.dispute.created' });
  delivery.data.object = { object: 'dispute', id: dispute.id, payment_intent: `pi_${attempt.id}`, charge: 'ch_one',
    amount: 2740, currency: 'eur', status: 'needs_response' } as Stripe.Dispute;
  await tracked(delivery); await processSignedPaymentEvent(delivery); await processSignedPaymentEvent(delivery);
  expect(await state(order.id)).toMatchObject({ status: 'PAID', paymentState: 'DISPUTED', paymentHold: true,
    paymentSummary: { refundedMinor: 1000, disputedMinor: 2740 } });
});
it('does not allow a concurrent new event to inherit a previous explicit review', async () => {
  const { order, attempt } = await fixture(); const admin = await createUser('ADMIN'); await reconcileOrderPayment(order.id);
  facts.set(attempt.id, { refunds: [refund] }); const held = await reconcileOrderPayment(order.id);
  const delivery = event(attempt, { type: 'refund.updated' });
  delivery.data.object = { object: 'refund', id: 're_new', charge: 'ch_one', payment_intent: `pi_${attempt.id}`,
    amount: 100, currency: 'eur', status: 'pending' } as Stripe.Refund;
  const saved = await tracked(delivery);
  await db.paymentEvent.update({ where: { id: saved.id }, data: { orderId: order.id, attemptId: attempt.id } });
  await expect(releasePaymentHold(order.id, admin.id, held.summary.fingerprint, 'Reviewed old facts only.')).rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
});
it('rechecks cancellation/manual settlement committed during provider I/O', async () => {
  const { order } = await fixture(); const admin = await createUser('ADMIN'); const implementation = provider.read.getMockImplementation()!;
  provider.read.mockImplementationOnce(async (...args) => {
    await db.$transaction(tx => applyOrderLifecycle(tx, order.id, { source: 'admin', operatorId: admin.id, update: {
      status: 'PAID', manualSettlement: { method: 'BANK_TRANSFER', reference: 'Synthetic manual receipt', confirmed: true },
    } }));
    return implementation(...args);
  });
  expect(await reconcileOrderPayment(order.id)).toMatchObject({ state: 'REVIEW', hold: true, settled: false });
  expect((await state(order.id)).manualSettlement).toMatchObject({ operatorId: admin.id });
  expect((await state(order.id)).vaultEntries).toHaveLength(1);
});
it('does not match a sessionless signed charge to a sessionless prepared attempt', async () => {
  const created = await createPendingOrderWithUser({ currency: 'EUR', vaultAddOn: true });
  await db.order.update({ where: { id: created.order.id }, data: { expectedMinorAmount: 2740, paymentState: 'UNPAID' } });
  const attempt = await preparePaymentAttempt(created.order.id, 'Émilie');
  await db.paymentAttempt.update({ where: { id: attempt.id }, data: { providerAccountId: 'acct_one' } });
  provider.charge.mockResolvedValue({ payment_intent: null });
  const delivery = event(attempt, { type: 'charge.succeeded' });
  delivery.data.object = { object: 'charge', id: 'ch_standalone', metadata: { orderId: created.order.id },
    amount: 2740, currency: 'eur', paid: true, captured: true, status: 'succeeded' } as unknown as Stripe.Charge;
  await tracked(delivery);
  expect((await processSignedPaymentEvent(delivery)).status).toBe('REVIEW');
  expect(await state(created.order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paymentHold: true, vaultEntries: [] });
});
it('publishes a recovered replacement session as the current order session', async () => {
  const created = await createPendingOrderWithUser({ currency: 'EUR', vaultAddOn: true });
  await db.order.update({ where: { id: created.order.id }, data: { expectedMinorAmount: 2740, paymentState: 'UNPAID', stripeSessionId: 'cs_expired_a' } });
  const legacy = await db.paymentAttempt.create({ data: { orderId: created.order.id, sequence: 1,
    idempotencyKey: `legacy-unissued:${created.order.id}:cs_expired_a`, sessionId: 'cs_expired_a',
    expectedMinorAmount: 2740, currency: 'EUR', livemode: false, providerAccountId: 'acct_one',
    providerRequest: { origin: 'LEGACY_STRIPE_SESSION', request: null }, status: 'EXPIRED', providerSnapshot: { status: 'EXPIRED' } } });
  const prepared = await preparePaymentAttempt(created.order.id, 'Émilie');
  await db.paymentAttempt.update({ where: { id: prepared.id }, data: { providerAccountId: 'acct_one' } });
  facts.set(legacy.id, { sessionId: 'cs_expired_a', status: 'EXPIRED', receivedMinor: 0, paymentIntentId: null });
  facts.set(prepared.id, { sessionId: 'cs_recovered', status: 'OPEN', receivedMinor: 0, paymentIntentId: null });
  expect(await reconcileOrderPayment(created.order.id)).toMatchObject({ state: 'UNPAID', hold: false });
  expect(await state(created.order.id)).toMatchObject({ stripeSessionId: 'cs_recovered' });
  expect(await db.paymentAttempt.findUniqueOrThrow({ where: { id: prepared.id } })).toMatchObject({ sessionId: 'cs_recovered', status: 'OPEN' });
});
it('finalizes the admin audit inside the settlement transaction', async () => {
  const { order } = await fixture(); const admin = await createUser('ADMIN');
  expect((await recordAdminReconciliation(order.id, admin.id)).settled).toBe(true);
  const audit = await db.paymentEvent.findFirstOrThrow({ where: { orderId: order.id, source: 'ADMIN_RECONCILIATION' } });
  expect(audit.status).toBe('PROCESSED');
  expect(JSON.parse(audit.outcome!)).toMatchObject({ state: 'PAID', settled: true });
});
it('rolls the admin audit back with a failed settlement instead of reporting failure after commit', async () => {
  const { order } = await fixture(); const admin = await createUser('ADMIN');
  provider.fault = true;
  await expect(recordAdminReconciliation(order.id, admin.id)).rejects.toThrow('Injected post-Vault failure');
  expect(await state(order.id)).toMatchObject({ status: 'PENDING_PAYMENT', paidAt: null, vaultEntries: [] });
  expect(await db.paymentEvent.findFirstOrThrow({ where: { orderId: order.id, source: 'ADMIN_RECONCILIATION' } }))
    .toMatchObject({ status: 'FAILED', outcome: 'CANONICAL_RECONCILIATION_FAILED' });
});
it('preserves the first completed delivery outcome across later clean reconciliations', async () => {
  const { order, attempt } = await fixture(); const delivery = event(attempt); await tracked(delivery);
  await processSignedPaymentEvent(delivery);
  const first = await db.paymentEvent.findUniqueOrThrow({ where: { providerEventId: delivery.id } });
  expect(JSON.parse(first.outcome!)).toMatchObject({ settled: true });
  await reconcileOrderPayment(order.id);
  const second = await db.paymentEvent.findUniqueOrThrow({ where: { providerEventId: delivery.id } });
  expect(second.outcome).toBe(first.outcome);
  expect(second.processedAt).toEqual(first.processedAt);
});
it('rejects a hold release when a newer reconciliation hold landed after the canonical read', async () => {
  const { order, attempt } = await fixture(); const admin = await createUser('ADMIN');
  await reconcileOrderPayment(order.id);
  facts.set(attempt.id, { refunds: [refund] });
  const held = await reconcileOrderPayment(order.id);
  provider.holdRace = true;
  await expect(releasePaymentHold(order.id, admin.id, held.summary.fingerprint, 'Finance reviewed this partial refund.'))
    .rejects.toMatchObject({ code: 'PAYMENT_REVIEW_REQUIRED' });
  await provider.holdRaceDone;
  expect((await state(order.id)).paymentHold).toBe(true);
});

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const actionRequest = (body: unknown) => new Request('http://localhost/api/admin/orders/fixture/payment', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function operator() {
  const admin = await createUser('ADMIN');
  authorization.auth.mockResolvedValue({ user: { id: admin.id, role: 'ADMIN' } });
  return admin;
}
it('payment history is private, minimized, read-only and includes every attempt/event', async () => {
  const { order, attempt } = await fixture(); await operator();
  const delivery = event(attempt); await tracked(delivery); await processSignedPaymentEvent(delivery);
  provider.read.mockClear(); provider.account.mockClear();
  const before = await state(order.id);
  const response = await paymentHistory(new Request('http://localhost'), routeParams(order.id));
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  const body = await response.json();
  expect(body.order).toMatchObject({ paymentState: 'PAID', paymentAttempts: [{ id: attempt.id }], paymentEvents: [{ providerEventId: delivery.id }] });
  expect(JSON.stringify(body)).not.toMatch(/providerRequest|customer_email|customer_details|private@example/);
  expect(provider.read).not.toHaveBeenCalled(); expect(provider.account).not.toHaveBeenCalled();
  expect(await state(order.id)).toEqual(before);
});
it.each(['anonymous', 'customer', 'downgraded'] as const)('denies %s history, action and queue access without provider reads or writes', async kind => {
  const { order, user } = await fixture();
  if (kind === 'customer') authorization.auth.mockResolvedValue({ user: { id: user.id, role: 'USER' } });
  if (kind === 'downgraded') { const admin = await operator(); await db.user.update({ where: { id: admin.id }, data: { role: 'USER' } }); }
  const before = await state(order.id);
  expect((await paymentHistory(new Request('http://localhost'), routeParams(order.id))).status).toBe(403);
  expect((await paymentAction(actionRequest({ action: 'RECONCILE' }), routeParams(order.id))).status).toBe(403);
  expect((await paymentQueue()).status).toBe(403);
  expect(provider.read).not.toHaveBeenCalled(); expect(await state(order.id)).toEqual(before);
});
it.each([
  { action: 'REFUND' }, { action: 'RECONCILE', operatorId: 'forged' },
  { action: 'RELEASE_HOLD', fingerprint: 'a'.repeat(64), explanation: 'Reviewed current facts.', confirmed: false },
  { action: 'RELEASE_HOLD', fingerprint: 'invalid', explanation: 'Reviewed current facts.', confirmed: true },
  { action: 'RELEASE_HOLD', fingerprint: 'a'.repeat(64), explanation: 'short', confirmed: true },
])('rejects invalid or forged financial actions %j before provider calls', async body => {
  const { order } = await fixture(); await operator();
  expect((await paymentAction(actionRequest(body), routeParams(order.id))).status).toBe(400);
  expect(provider.read).not.toHaveBeenCalled();
  expect(await db.paymentEvent.count({ where: { orderId: order.id } })).toBe(0);
});
it('validates malformed JSON, missing orders, unavailable configuration and rate limits', async () => {
  const { order } = await fixture(); await operator();
  expect((await paymentAction(new Request('http://localhost', { method: 'POST', body: '{' }), routeParams(order.id))).status).toBe(400);
  expect((await paymentHistory(new Request('http://localhost'), routeParams(randomUUID()))).status).toBe(404);
  expect((await paymentAction(actionRequest({ action: 'RECONCILE' }), routeParams(randomUUID()))).status).toBe(404);
  vi.stubEnv('STRIPE_SECRET_KEY', '');
  expect((await paymentAction(actionRequest({ action: 'RECONCILE' }), routeParams(order.id))).status).toBe(503);
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_synthetic_local_only');
  authorization.limit.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 60 });
  expect((await paymentAction(actionRequest({ action: 'RECONCILE' }), routeParams(order.id))).status).toBe(429);
  expect(provider.read).not.toHaveBeenCalled();
});
it('admin action records the authenticated operator and sanitizes durable failed outcomes', async () => {
  const { order } = await fixture(); const admin = await operator();
  provider.account.mockRejectedValueOnce(new Error('secret provider diagnostic with private@example.invalid'));
  const failed = await paymentAction(actionRequest({ action: 'RECONCILE' }), routeParams(order.id));
  expect(failed.status).toBe(502); expect(JSON.stringify(await failed.json())).not.toMatch(/secret|private@example/);
  expect(await state(order.id)).toMatchObject({ paymentHold: true, status: 'PENDING_PAYMENT', vaultEntries: [] });
  const saved = await db.paymentEvent.findFirstOrThrow({ where: { orderId: order.id } });
  expect(saved).toMatchObject({ source: 'ADMIN_RECONCILIATION', status: 'FAILED', data: { operatorId: admin.id }, outcome: 'CANONICAL_RECONCILIATION_FAILED' });
  expect((await paymentAction(actionRequest({ action: 'RECONCILE' }), routeParams(order.id))).status).toBe(200);
  expect(await state(order.id)).toMatchObject({ status: 'PAID', paymentState: 'PAID', paymentHold: false });
});
it('release endpoint reviews current fingerprints and never changes payment/fulfillment or initiates refunds', async () => {
  const { order, attempt } = await fixture(); const admin = await operator(); await reconcileOrderPayment(order.id);
  facts.set(attempt.id, { refunds: [refund] }); const held = await reconcileOrderPayment(order.id);
  const body = { action: 'RELEASE_HOLD', fingerprint: held.summary.fingerprint, explanation: 'Finance explicitly reviewed current refund facts.', confirmed: true };
  facts.set(attempt.id, { refunds: [{ ...refund, amountMinor: 2000 }] });
  expect((await paymentAction(actionRequest(body), routeParams(order.id))).status).toBe(409);
  const latest = await reconcileOrderPayment(order.id);
  expect((await paymentAction(actionRequest({ ...body, fingerprint: latest.summary.fingerprint }), routeParams(order.id))).status).toBe(200);
  expect(await state(order.id)).toMatchObject({ status: 'PAID', paymentState: 'PARTIALLY_REFUNDED', paymentHold: false });
  expect(await db.paymentEvent.findFirstOrThrow({ where: { orderId: order.id, source: 'ADMIN_REVIEW' } })).toMatchObject({ data: { operatorId: admin.id, fingerprint: latest.summary.fingerprint } });
  expect((await state(order.id)).vaultEntries).toHaveLength(1);
});
it('queue retains unmatched/failed and held-review events independently of fulfillment filters', async () => {
  const { order, attempt } = await fixture(); await operator();
  const delivery = event(attempt); (delivery.data.object as Stripe.Checkout.Session).id = 'cs_not_issued';
  const held = await tracked(delivery); await processSignedPaymentEvent(delivery);
  const unmatchedDelivery = event(attempt); unmatchedDelivery.data.object = { object: 'checkout.session', id: 'cs_unknown', metadata: {} } as Stripe.Checkout.Session;
  const unmatched = await tracked(unmatchedDelivery); await processSignedPaymentEvent(unmatchedDelivery);
  const response = await paymentQueue(); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  const queue = await response.json();
  expect(queue.events).toEqual(expect.arrayContaining([expect.objectContaining({ id: held.id, orderId: order.id, status: 'REVIEW' }), expect.objectContaining({ id: unmatched.id, orderId: null, status: 'UNMATCHED' })]));
  expect(queue.eventCount).toBeGreaterThanOrEqual(2);
});
