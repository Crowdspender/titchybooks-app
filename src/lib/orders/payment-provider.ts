import type Stripe from 'stripe';
import type { PaymentAttempt } from '@prisma/client';
import { getStripeClient, retrieveStripeAccountContext } from '@/lib/stripe';
import type { CanonicalPaymentProof } from './payment-state';

export class ProviderSnapshotChanged extends Error {
  constructor() { super('Canonical provider state changed during reconciliation'); }
}
export const providerId = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === 'string' ? value : value?.id ?? null;

/** Traverse every page. A bounded incomplete response is an error, never a
 * partial balance published as canonical. No search-index consistency reliance.
 */
export async function providerPages<T extends { id: string }>(page: (cursor?: string) => Promise<{ data: T[]; has_more: boolean }>): Promise<T[]> {
  const rows: T[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const result = await page(cursor);
    rows.push(...result.data);
    if (!result.has_more) return rows;
    cursor = result.data.at(-1)?.id;
    if (!cursor || cursors.has(cursor)) throw new Error('Incomplete provider pagination');
    cursors.add(cursor);
  }
  throw new Error('Provider pagination limit requires review');
}
export type ProviderContext = Awaited<ReturnType<typeof retrieveStripeAccountContext>>;

/** Recover an unpublished response by recorded metadata, without creating a
 * new Checkout or relying on Stripe's eventually consistent search API.
 */
export async function discoverAttemptSessions(attempt: PaymentAttempt): Promise<Stripe.Checkout.Session[]> {
  if (!attempt.requestStartedAt) return [];
  const sessions = await providerPages(cursor => getStripeClient().checkout.sessions.list({
    limit: 100, starting_after: cursor, created: { gte: Math.floor(attempt.requestStartedAt!.getTime() / 1000) - 60 },
  }));
  return sessions.filter(session => session.metadata?.attemptId === attempt.id);
}
const sessionStamp = (s: Stripe.Checkout.Session) => JSON.stringify({ id: s.id, mode: s.mode, livemode: s.livemode,
  reference: s.client_reference_id, metadata: s.metadata, amount: s.amount_total, subtotal: s.amount_subtotal,
  currency: s.currency, paymentIntent: providerId(s.payment_intent), status: s.status, paymentStatus: s.payment_status,
  details: s.total_details, automaticTax: s.automatic_tax?.enabled });
const intentStamp = (p: Stripe.PaymentIntent) => JSON.stringify({ id: p.id, livemode: p.livemode, metadata: p.metadata,
  amount: p.amount, received: p.amount_received, currency: p.currency, status: p.status, latestCharge: providerId(p.latest_charge) });

/** Minimized canonical financial proof. Metadata alone never authorizes payment:
 * the recorded request, account/mode, session, intent, charges and adjustments
 * must all agree. All network I/O belongs outside database transactions.
 */
export async function readCanonicalAttempt(attempt: PaymentAttempt, context: ProviderContext): Promise<CanonicalPaymentProof> {
  const client = getStripeClient();
  const proof: CanonicalPaymentProof = { attemptId: attempt.id, sessionId: attempt.sessionId,
    paymentIntentId: attempt.paymentIntentId, expectedAccountId: attempt.providerAccountId,
    accountId: context.accountId, expectedLivemode: attempt.livemode, livemode: context.livemode,
    expectedMinorAmount: attempt.expectedMinorAmount, amountMinor: attempt.expectedMinorAmount, currency: attempt.currency,
    status: attempt.status, receivedMinor: 0, refunds: [], disputes: [], reviewReasons: [] };
  const reasons = proof.reviewReasons;
  if (!attempt.sessionId) {
    const discovered = await discoverAttemptSessions(attempt);
    if (discovered.length !== 1) {
      if (discovered.length > 1) {
        reasons.push('multiple-issued-sessions');
        proof.unmatchedSessionIds = discovered.map(s => s.id).sort();
      }
      if (attempt.requestStartedAt) reasons.push('unpublished-provider-request');
      return proof;
    }
    proof.sessionId = discovered[0].id;
  }
  const session = await client.checkout.sessions.retrieve(proof.sessionId!);
  const legacy = (attempt.providerRequest as Record<string, unknown>).origin === 'LEGACY_STRIPE_SESSION';
  if (session.id !== proof.sessionId || session.mode !== 'payment' || session.client_reference_id !== attempt.orderId ||
      session.metadata?.orderId !== attempt.orderId || (!legacy && session.metadata?.attemptId !== attempt.id)) reasons.push('session-reference-mismatch');
  proof.livemode = session.livemode;
  proof.currency = session.currency?.toUpperCase() ?? '';
  proof.amountMinor = session.amount_total ?? -1;
  if (session.amount_subtotal !== session.amount_total || session.automatic_tax?.enabled ||
      session.total_details?.amount_discount !== 0 || session.total_details?.amount_tax !== 0 ||
      session.total_details?.amount_shipping !== 0) reasons.push('session-adjustment-mismatch');
  const intentId = providerId(session.payment_intent);
  if (attempt.paymentIntentId && intentId !== attempt.paymentIntentId) reasons.push('payment-reference-changed');
  proof.paymentIntentId = intentId;
  if (!intentId) {
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') reasons.push('missing-payment-reference');
    proof.status = session.status === 'expired' ? 'EXPIRED' : session.status === 'open' ? 'OPEN' : 'REVIEW';
    if (sessionStamp(session) !== sessionStamp(await client.checkout.sessions.retrieve(session.id))) throw new ProviderSnapshotChanged();
    return proof;
  }
  const intent = await client.paymentIntents.retrieve(intentId);
  if (intent.id !== intentId || intent.metadata?.orderId !== attempt.orderId ||
      (!legacy && intent.metadata?.attemptId !== attempt.id)) reasons.push('intent-reference-mismatch');
  if (intent.livemode !== session.livemode || intent.livemode !== context.livemode) reasons.push('mode-mismatch');
  if (intent.amount !== session.amount_total || intent.currency !== session.currency) reasons.push('intent-charge-mismatch');
  proof.receivedMinor = intent.amount_received;
  proof.status = intent.status === 'succeeded' ? 'SUCCEEDED' : intent.status === 'processing' ? 'PROCESSING'
    : session.status === 'expired' && intent.amount_received === 0 ? 'EXPIRED'
    : intent.status === 'canceled' ? 'FAILED' : session.status === 'open' ? 'OPEN'
    : intent.status === 'requires_payment_method' ? 'FAILED' : 'REVIEW';
  if (intent.status === 'succeeded' && session.payment_status !== 'paid') reasons.push('session-payment-status-mismatch');
  const charges = await providerPages(cursor => client.charges.list({ payment_intent: intentId, limit: 100, starting_after: cursor }));
  let captured = 0;
  const chargeIds = new Set<string>();
  for (const charge of charges) {
    if (chargeIds.has(charge.id)) { reasons.push('duplicate-provider-charge'); continue; }
    chargeIds.add(charge.id);
    if (providerId(charge.payment_intent) !== intentId || charge.currency !== intent.currency || charge.livemode !== intent.livemode) reasons.push('charge-reference-mismatch');
    if (charge.paid && charge.captured && charge.status === 'succeeded') captured += charge.amount_captured;
    else if (charge.amount_captured > 0) reasons.push('unconfirmed-capture');
    const refunds = await providerPages(cursor => client.refunds.list({ charge: charge.id, limit: 100, starting_after: cursor }));
    let refunded = 0;
    let pendingRefunded = 0;
    const refundIds = new Set<string>();
    for (const refund of refunds) {
      if (refundIds.has(refund.id)) { reasons.push('duplicate-provider-refund'); continue; }
      refundIds.add(refund.id);
      if (providerId(refund.charge) !== charge.id || providerId(refund.payment_intent) !== intentId || refund.currency !== intent.currency) reasons.push('refund-reference-mismatch');
      proof.refunds.push({ id: refund.id, chargeId: charge.id, amountMinor: refund.amount, currency: refund.currency.toUpperCase(), status: refund.status ?? 'unknown' });
      if (refund.status === 'succeeded') refunded += refund.amount;
      else if (refund.status === 'pending' || refund.status === 'requires_action') pendingRefunded += refund.amount;
    }
    const disputes = await providerPages(cursor => client.disputes.list({ charge: charge.id, limit: 100, starting_after: cursor }));
    if (charge.disputed && !disputes.length) throw new ProviderSnapshotChanged();
    for (const dispute of disputes) {
      if (providerId(dispute.charge) !== charge.id || providerId(dispute.payment_intent) !== intentId || dispute.currency !== intent.currency || dispute.livemode !== intent.livemode) reasons.push('dispute-reference-mismatch');
      proof.disputes.push({ id: dispute.id, chargeId: charge.id, amountMinor: dispute.amount, currency: dispute.currency.toUpperCase(), status: dispute.status });
    }
    // Detect refunds that arrived while traversing their pages; do not publish a
    // partial snapshot, even if a delivery is still on its way to this endpoint.
    // Stripe does not document whether amount_refunded includes in-flight refunds,
    // so accept either the succeeded-only or the succeeded+pending aggregate: a
    // mid-pagination arrival is still detected under either interpretation.
    const current = await client.charges.retrieve(charge.id);
    if ((current.amount_refunded !== refunded && current.amount_refunded !== refunded + pendingRefunded) ||
        current.amount_captured !== charge.amount_captured || current.disputed !== charge.disputed) throw new ProviderSnapshotChanged();
  }
  if (providerId(intent.latest_charge) && !chargeIds.has(providerId(intent.latest_charge)!)) reasons.push('missing-latest-charge');
  if (captured !== intent.amount_received) reasons.push('capture-total-mismatch');
  if (intentStamp(intent) !== intentStamp(await client.paymentIntents.retrieve(intentId)) ||
      sessionStamp(session) !== sessionStamp(await client.checkout.sessions.retrieve(session.id))) throw new ProviderSnapshotChanged();
  if (context.accountId !== attempt.providerAccountId) reasons.push('account-mismatch');
  return proof;
}
