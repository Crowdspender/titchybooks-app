import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PaymentAttempt, PaymentEvent } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { isCurrency } from '@/lib/pricing/currency';
import { expireCheckoutSession, retrieveOrderCheckoutSession, retrieveStripeAccountContext } from '@/lib/stripe';
import { applyOrderLifecycle } from './lifecycle';
import { readCanonicalAttempt, ProviderSnapshotChanged, type ProviderContext } from './payment-provider';
import { projectPayment, type CanonicalPaymentProof } from './payment-state';
import { PaymentReviewRequired } from './payment-attempts';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Import only the session already linked by the pre-migration order. Unknown
 * historical FX, accepted terms, provider request and idempotency stay unknown.
 * This record must never be reissued; only a new recorded successor can issue.
 */
export async function importLegacyPaymentAttempt(orderId: string, context?: ProviderContext): Promise<PaymentAttempt | null> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!order.stripeSessionId) return null;
  const known = await prisma.paymentAttempt.findUnique({ where: { sessionId: order.stripeSessionId } });
  if (known) {
    if (known.orderId !== orderId) throw new PaymentReviewRequired();
    return known;
  }
  if (!isCurrency(order.currency)) throw new PaymentReviewRequired();
  const account = context ?? await retrieveStripeAccountContext();
  const session = await retrieveOrderCheckoutSession(order.stripeSessionId, order.id, order.currency);
  if (session.livemode !== account.livemode || session.amount_total === null ||
      (order.expectedMinorAmount !== null && session.amount_total !== order.expectedMinorAmount)) throw new PaymentReviewRequired();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const current = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (current.stripeSessionId !== session.id || current.currency !== order.currency ||
        (current.expectedMinorAmount !== null && current.expectedMinorAmount !== session.amount_total)) throw new ProviderSnapshotChanged();
    const existing = await tx.paymentAttempt.findUnique({ where: { sessionId: session.id } });
    if (existing) {
      if (existing.orderId !== orderId) throw new PaymentReviewRequired();
      return existing;
    }
    const previous = await tx.paymentAttempt.findFirst({ where: { orderId }, orderBy: { sequence: 'desc' } });
    const imported = await tx.paymentAttempt.create({ data: { orderId, sequence: (previous?.sequence ?? 0) + 1,
      idempotencyKey: `legacy-unissued:${orderId}:${session.id}`, sessionId: session.id,
      expectedMinorAmount: session.amount_total!, currency: order.currency, livemode: session.livemode,
      providerAccountId: account.accountId, providerRequest: { origin: 'LEGACY_STRIPE_SESSION', request: null },
      status: 'REVIEW' } });
    await tx.order.update({ where: { id: orderId }, data: {
      ...(current.expectedMinorAmount === null ? { expectedMinorAmount: session.amount_total!,
        quoteSnapshot: { version: 1, origin: 'LEGACY_STRIPE_SESSION', sessionId: session.id,
          amountMinor: session.amount_total, currency: order.currency, fxRate: null, acceptedAt: null,
          observedAt: new Date().toISOString(), livemode: session.livemode } } : {}),
      paymentRevision: { increment: 1 },
    } });
    return imported;
  });
}

/** Manual settlement must not leave a payable Checkout session behind. Close an
 * open unpaid session first; a started/completed payment must be reconciled, and
 * a held order is left for the lifecycle guard to reject without provider writes.
 * All provider I/O happens here, outside the settlement transaction.
 */
export async function closeCheckoutSessionForManualSettlement(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({ where: { id: orderId },
    select: { id: true, status: true, paymentHold: true, stripeSessionId: true, currency: true } });
  if (!order?.stripeSessionId || order.status !== 'PENDING_PAYMENT' || order.paymentHold || !isCurrency(order.currency)) return;
  const session = await retrieveOrderCheckoutSession(order.stripeSessionId, order.id, order.currency);
  if (session.payment_status === 'paid' || session.status === 'complete') {
    throw new PaymentReviewRequired('A Stripe payment is already in progress. Reconcile it before recording a manual settlement.');
  }
  if (session.status === 'open') {
    try { await expireCheckoutSession(session.id); }
    catch { throw new PaymentReviewRequired('The checkout session changed while closing it. Reconcile the payment before recording a manual settlement.'); }
  }
}

/** An event is a wake-up/reference hint, not a payment balance. Compare only
 * stable IDs/context to the fresh canonical snapshot, never old event totals.
 */
function eventReasons(event: PaymentEvent, proofs: CanonicalPaymentProof[], context: ProviderContext): string[] {
  const reasons: string[] = [];
  if (event.livemode !== null && event.livemode !== context.livemode) reasons.push('event-mode-mismatch');
  if (event.providerAccountId && event.providerAccountId !== context.accountId) reasons.push('event-account-mismatch');
  if (event.source !== 'SIGNED_WEBHOOK') return reasons;
  const data = event.data as Record<string, unknown>;
  // Two absent session IDs are not a reference: a standalone charge without a
  // Checkout Session must never match a sessionless PREPARED attempt.
  const matching = proofs.filter(p => p.attemptId === event.attemptId ||
    (p.sessionId && data.sessionId && p.sessionId === data.sessionId) ||
    (p.paymentIntentId && p.paymentIntentId === data.paymentIntentId) ||
    p.refunds.some(r => r.id === event.objectId) || p.disputes.some(d => d.id === event.objectId));
  if (!matching.length) reasons.push('unknown-provider-reference');
  if (data.orderId && data.orderId !== event.orderId) reasons.push('event-order-reference-mismatch');
  if (data.attemptId && !matching.some(p => p.attemptId === data.attemptId)) reasons.push('event-attempt-reference-mismatch');
  if (data.sessionId && !matching.some(p => p.sessionId === data.sessionId)) reasons.push('event-session-reference-mismatch');
  if (data.paymentIntentId && !matching.some(p => p.paymentIntentId === data.paymentIntentId)) reasons.push('event-payment-reference-mismatch');
  if (data.currency && !matching.some(p => p.currency === String(data.currency).toUpperCase())) reasons.push('event-currency-mismatch');
  if (typeof data.amountMinor === 'number') {
    const expected = data.objectType === 'refund' ? matching.flatMap(p => p.refunds.filter(r => r.id === event.objectId).map(r => r.amountMinor))
      : data.objectType === 'dispute' ? matching.flatMap(p => p.disputes.filter(d => d.id === event.objectId).map(d => d.amountMinor))
      : matching.map(p => p.amountMinor);
    if (!expected.includes(data.amountMinor)) reasons.push('event-amount-mismatch');
  }
  if (data.objectType === 'refund' && !matching.some(p => p.refunds.some(r => r.id === event.objectId))) reasons.push('missing-canonical-refund');
  if (data.objectType === 'dispute' && !matching.some(p => p.disputes.some(d => d.id === event.objectId))) reasons.push('missing-canonical-dispute');
  return reasons;
}

/** Fetch outside transactions; atomically publish only if no issuance, event,
 * review or competing reconciliation changed the order revision in the meantime.
 * All known earlier attempts participate, not only Order.stripeSessionId.
 */
export async function reconcileOrderPayment(orderId: string, auditEventId?: string) {
  for (let retry = 0; retry < 4; retry++) {
    try {
      const context = await retrieveStripeAccountContext();
      await importLegacyPaymentAttempt(orderId, context);
      // Use one transactional database snapshot, but never provider I/O inside it.
      const snapshot = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        return { order: await tx.order.findUniqueOrThrow({ where: { id: orderId } }),
          attempts: await tx.paymentAttempt.findMany({ where: { orderId }, orderBy: { sequence: 'asc' } }),
          events: await tx.paymentEvent.findMany({ where: { orderId, source: 'SIGNED_WEBHOOK' } }) };
      });
      const proofs = await Promise.all(snapshot.attempts.map(attempt => readCanonicalAttempt(attempt, context)));
      const reasonsByEvent = snapshot.events.map(event => ({ event, reasons: eventReasons(event, proofs, context) }));
      const published = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
        const current = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        if (current.paymentRevision !== snapshot.order.paymentRevision) return null;
        const reviews = await tx.paymentEvent.findMany({ where: { orderId, source: 'ADMIN_REVIEW', status: 'PROCESSED' }, orderBy: { createdAt: 'desc' }, take: 1 });
        const reviewedFingerprint = (reviews[0]?.data as Record<string, unknown> | undefined)?.fingerprint;
        const projection = projectPayment({ expectedMinorAmount: current.expectedMinorAmount, currency: current.currency,
          fulfillment: current.status, hasManualSettlement: !!current.manualSettlement,
          reviewedFingerprint: typeof reviewedFingerprint === 'string' ? reviewedFingerprint : null,
          reviewReasons: reasonsByEvent.flatMap(item => item.reasons) }, proofs);
        for (const proof of proofs) {
          const original = snapshot.attempts.find(a => a.id === proof.attemptId)!;
          await tx.paymentAttempt.update({ where: { id: original.id }, data: {
            // Preserve immutable references on mismatches; minimized snapshot retains
            // the observed alternatives for review instead of rewriting history.
            ...(!original.sessionId && proof.sessionId && !proof.reviewReasons.includes('session-reference-mismatch') ? { sessionId: proof.sessionId } : {}),
            ...(!original.paymentIntentId && proof.paymentIntentId && !proof.reviewReasons.some(r => r.includes('reference-mismatch') || r === 'payment-reference-changed') ? { paymentIntentId: proof.paymentIntentId } : {}),
            status: proof.reviewReasons.length ? 'REVIEW' : proof.status, providerSnapshot: json(proof), failureCode: null,
          } });
        }
        // A verified open session on the latest attempt becomes the current
        // pointer; an expired predecessor must not block resuming its replacement.
        const latestProof = proofs.at(-1);
        const recoveredSession = latestProof?.sessionId && !latestProof.reviewReasons.length &&
          (latestProof.status === 'OPEN' || !current.stripeSessionId) ? latestProof.sessionId : null;
        await tx.order.update({ where: { id: orderId }, data: { paymentState: projection.state, paymentHold: projection.hold,
          paymentSummary: json(projection.summary), paymentRevision: { increment: 1 },
          ...(recoveredSession && current.stripeSessionId !== recoveredSession ? { stripeSessionId: recoveredSession } : {}),
        } });
        let settled = false;
        if (projection.canSettle || (projection.state === 'PAID' && !projection.hold &&
            ['PAID', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED'].includes(current.status))) {
          const result = await applyOrderLifecycle(tx, orderId, { source: 'stripe' });
          if (!result.ok) throw new Error('Canonical settlement conflict');
          settled = result.settled;
        }
        for (const { event, reasons } of reasonsByEvent) {
          const status = reasons.length || projection.hold ? 'REVIEW' : 'PROCESSED';
          // Keep the first completed outcome and timestamp: a later clean
          // delivery must not rewrite the record of the delivery that settled.
          if (event.status === 'PROCESSED' && status === 'PROCESSED') continue;
          await tx.paymentEvent.update({ where: { id: event.id }, data: {
            status, processedAt: new Date(),
            outcome: JSON.stringify({ fingerprint: projection.summary.fingerprint, state: projection.state, reasons, settled })
          } });
        }
        // The operator audit commits with the settlement it describes; a later
        // separate update could report failure after settlement already committed.
        if (auditEventId) await tx.paymentEvent.update({ where: { id: auditEventId }, data: {
          status: projection.hold ? 'REVIEW' : 'PROCESSED', processedAt: new Date(),
          outcome: JSON.stringify({ state: projection.state, fingerprint: projection.summary.fingerprint, settled }) } });
        return { ...projection, settled, revision: current.paymentRevision + 1 };
      });
      if (published) return published;
    } catch (error) {
      if (!(error instanceof ProviderSnapshotChanged)) throw error;
    }
  }
  throw new ProviderSnapshotChanged();
}

/** Every admin fetch has a durable operator/result record, including failures.
 * Caller supplies the current authenticated operator; no in-app refunds occur.
 */
export async function recordAdminReconciliation(orderId: string, operatorId: string) {
  if (!operatorId.trim()) throw new Error('Missing operator identity');
  const data = { operatorId };
  const event = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const recorded = await tx.paymentEvent.create({ data: { providerEventId: `admin:${randomUUID()}`,
      source: 'ADMIN_RECONCILIATION', type: 'canonical.reconciliation', orderId, data, dataDigest: digest(data) } });
    await tx.order.update({ where: { id: orderId }, data: { paymentHold: true, paymentRevision: { increment: 1 } } });
    return recorded;
  });
  try {
    return await reconcileOrderPayment(orderId, event.id);
  } catch (error) {
    // An ambiguous commit may already have finalized the audit row inside the
    // publish transaction; never overwrite a committed outcome with FAILED.
    const stored = await prisma.paymentEvent.findUnique({ where: { id: event.id } });
    if (!stored || stored.status === 'RECEIVED' || stored.status === 'FAILED') {
      await prisma.paymentEvent.update({ where: { id: event.id }, data: { status: 'FAILED', processedAt: new Date(), outcome: 'CANONICAL_RECONCILIATION_FAILED' } });
    }
    throw error;
  }
}

/** An explicit financial/fulfillment review releases only unchanged facts.
 * It neither revives canceled orders nor calls a refund/payment provider API.
 */
export async function releasePaymentHold(orderId: string, operatorId: string, fingerprint: string, explanation: string) {
  if (!operatorId.trim() || !/^[a-f0-9]{64}$/.test(fingerprint) || explanation.trim().length < 10 || explanation.trim().length > 1000) throw new PaymentReviewRequired();
  // Fresh canonical fetch prevents releasing an already obsolete refund/dispute.
  const reconciled = await reconcileOrderPayment(orderId);
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    const summary = order.paymentSummary as Record<string, unknown> | null;
    const pendingEvents = await tx.paymentEvent.count({ where: { orderId, source: 'SIGNED_WEBHOOK', status: { in: ['RECEIVED', 'FAILED'] } } });
    // A newer reconciliation hold committed after the canonical read must survive
    // this release even when its failed fetch left the fingerprint unchanged.
    if (!order.paymentHold || pendingEvents || order.paymentRevision !== reconciled.revision ||
        summary?.fingerprint !== fingerprint) throw new PaymentReviewRequired('Payment facts changed. Reconcile and review the current history.');
    const data = { operatorId, fingerprint, explanation: explanation.trim() };
    await tx.paymentEvent.create({ data: { providerEventId: `review:${randomUUID()}`, source: 'ADMIN_REVIEW',
      type: 'fulfillment.hold_released', orderId, data, dataDigest: digest(data), status: 'PROCESSED', processedAt: new Date() } });
    return tx.order.update({ where: { id: orderId }, data: { paymentHold: false, paymentRevision: { increment: 1 } } });
  });
}
