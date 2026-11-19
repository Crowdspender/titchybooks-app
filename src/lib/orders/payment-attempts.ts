import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { isCurrency } from '@/lib/pricing/currency';
import { assertChargeAmount } from '@/lib/pricing/charge';
import { buildCheckoutRequest, CheckoutSessionUnavailable, createCheckoutSession, retrieveOrderCheckoutSession, retrieveStripeAccountContext, stripeLivemode, type CheckoutSessionResult } from '@/lib/stripe';

export class PaymentReviewRequired extends Error {
  readonly code = 'PAYMENT_REVIEW_REQUIRED';
  constructor(message = 'Payment needs review. This order, its accepted charge, and all issued attempts are retained.') { super(message); }
}
// Stripe may discard idempotency keys after 24 hours. Never blindly reissue an
// ambiguous request once the safe recovery window has elapsed.
export const PAYMENT_RECOVERY_WINDOW_MS = 23 * 60 * 60_000;

/** Order lock serializes issuance decisions. No provider calls occur here. */
export async function preparePaymentAttempt(orderId: string, submissionTitle: string, customerEmail?: string | null) {
  const livemode = stripeLivemode();
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (order.status !== 'PENDING_PAYMENT' || order.paymentHold || order.expectedMinorAmount === null || !isCurrency(order.currency)) throw new PaymentReviewRequired();
    assertChargeAmount(order.expectedMinorAmount, order.currency);
    const previous = await tx.paymentAttempt.findFirst({ where: { orderId }, orderBy: { sequence: 'desc' } });
    if (previous && !['EXPIRED', 'FAILED'].includes(previous.status)) {
      if (previous.livemode !== livemode || ['SUCCEEDED', 'REVIEW'].includes(previous.status)) throw new PaymentReviewRequired();
      return previous;
    }
    // A pre-migration session must be canonically imported before replacing it.
    if (!previous && (order.stripeSessionId || order.paymentState === null)) throw new PaymentReviewRequired();
    if (previous && (!previous.sessionId || !previous.providerSnapshot || previous.livemode !== livemode)) throw new PaymentReviewRequired();
    const sequence = (previous?.sequence ?? 0) + 1;
    const id = randomUUID();
    const idempotencyKey = `order:${orderId}:${previous?.sessionId ? `after:${previous.sessionId}` : 'initial'}`;
    const providerRequest = buildCheckoutRequest({ orderId, submissionTitle, customerEmail,
      amountMinor: order.expectedMinorAmount, currency: order.currency, idempotencyKey, attemptId: id });
    const attempt = await tx.paymentAttempt.create({ data: { id, orderId, sequence, idempotencyKey,
      expectedMinorAmount: order.expectedMinorAmount, currency: order.currency, livemode,
      providerRequest: JSON.parse(JSON.stringify(providerRequest)) as Prisma.InputJsonValue } });
    await tx.order.update({ where: { id: orderId }, data: { paymentState: 'UNPAID', paymentRevision: { increment: 1 } } });
    return attempt;
  });
}

/** Recover exactly the recorded request. Request/account/session publication is
 * fenced by short transactions, but all Stripe calls happen after those commits.
 */
export async function issuePaymentAttempt(attemptId: string): Promise<CheckoutSessionResult & { attemptId: string }> {
  let attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  if (!isCurrency(attempt.currency) || attempt.livemode !== stripeLivemode()) throw new PaymentReviewRequired();
  if (attempt.sessionId) {
    if (attempt.status !== 'OPEN') throw new PaymentReviewRequired();
    const context = await retrieveStripeAccountContext();
    if (context.accountId !== attempt.providerAccountId || context.livemode !== attempt.livemode) throw new PaymentReviewRequired();
    const session = await retrieveOrderCheckoutSession(attempt.sessionId, attempt.orderId, attempt.currency);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: attempt.orderId } });
    if (order.status !== 'PENDING_PAYMENT' || order.paymentHold || order.stripeSessionId !== session.id ||
        session.status !== 'open' || session.payment_status !== 'unpaid' || session.amount_total !== attempt.expectedMinorAmount || !session.url) throw new PaymentReviewRequired();
    return { url: session.url, sessionId: session.id, attemptId: attempt.id };
  }
  try {
    // Validate under the order lock without writing anything: an attempt whose
    // provider request never started must survive a failed account lookup
    // untouched, so a later retry can still issue the identical frozen request.
    attempt = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${attempt.orderId} FOR UPDATE`;
      const [order, current] = await Promise.all([
        tx.order.findUniqueOrThrow({ where: { id: attempt.orderId } }),
        tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      ]);
      if (order.status !== 'PENDING_PAYMENT' || order.paymentHold || current.livemode !== stripeLivemode() ||
          order.expectedMinorAmount !== current.expectedMinorAmount || order.currency !== current.currency) throw new PaymentReviewRequired();
      if (current.sessionId) return current;
      if (!['PREPARED', 'AMBIGUOUS'].includes(current.status) || (current.requestStartedAt && Date.now() - current.requestStartedAt.getTime() >= PAYMENT_RECOVERY_WINDOW_MS)) throw new PaymentReviewRequired();
      return current;
    });
    if (attempt.sessionId) return issuePaymentAttempt(attempt.id);
    const context = await retrieveStripeAccountContext();
    if (context.livemode !== attempt.livemode || (attempt.providerAccountId && attempt.providerAccountId !== context.accountId)) throw new PaymentReviewRequired();
    // Bind the account and mark the request started only after the lookup
    // succeeded. Re-read under the lock so a competing writer's binding or
    // published session is never overwritten; immutable fields pass through.
    attempt = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${attempt.orderId} FOR UPDATE`;
      const [order, current] = await Promise.all([
        tx.order.findUniqueOrThrow({ where: { id: attempt.orderId } }),
        tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      ]);
      if (order.status !== 'PENDING_PAYMENT' || order.paymentHold) throw new PaymentReviewRequired();
      if (current.sessionId) return current;
      if ((current.providerAccountId && current.providerAccountId !== context.accountId) ||
          !['PREPARED', 'AMBIGUOUS'].includes(current.status) ||
          (current.requestStartedAt && Date.now() - current.requestStartedAt.getTime() >= PAYMENT_RECOVERY_WINDOW_MS)) throw new PaymentReviewRequired();
      const started = await tx.paymentAttempt.update({ where: { id: current.id }, data: {
        providerAccountId: current.providerAccountId ?? context.accountId,
        requestStartedAt: current.requestStartedAt ?? new Date(), status: 'AMBIGUOUS', failureCode: null,
      } });
      await tx.order.update({ where: { id: order.id }, data: { paymentRevision: { increment: 1 } } });
      return started;
    });
    if (attempt.sessionId) return issuePaymentAttempt(attempt.id);
    const result = await createCheckoutSession({ orderId: attempt.orderId, submissionTitle: 'TitchyBook',
      amountMinor: attempt.expectedMinorAmount, currency: attempt.currency as 'HUF' | 'EUR' | 'GBP',
      idempotencyKey: attempt.idempotencyKey, attemptId: attempt.id,
      providerRequest: attempt.providerRequest as unknown as Stripe.Checkout.SessionCreateParams });
    const published = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${attempt.orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: attempt.orderId } });
      const current = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
      if (current.sessionId && current.sessionId !== result.sessionId) throw new PaymentReviewRequired();
      // A webhook may already have published and reconciled this same session.
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: {
        sessionId: result.sessionId,
        status: !current.sessionId && ['PREPARED', 'AMBIGUOUS'].includes(current.status) ? 'OPEN' : current.status,
        failureCode: null,
      } });
      const latest = await tx.paymentAttempt.findFirst({ where: { orderId: order.id }, orderBy: { sequence: 'desc' } });
      const eligible = order.status === 'PENDING_PAYMENT' && !order.paymentHold && latest?.id === attempt.id &&
        ['PREPARED', 'AMBIGUOUS', 'OPEN'].includes(current.status);
      await tx.order.update({ where: { id: order.id }, data: {
        ...(eligible ? { stripeSessionId: result.sessionId } : {}), paymentRevision: { increment: 1 },
      } });
      return eligible;
    });
    if (!published) throw new PaymentReviewRequired();
    return { ...result, attemptId: attempt.id };
  } catch (error) {
    // Never overwrite a session/reconciliation another writer already committed,
    // and never condemn an attempt whose provider request never started: an
    // unstarted PREPARED attempt stays retryable instead of being held for review.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${attempt.orderId} FOR UPDATE`;
      const review = error instanceof PaymentReviewRequired || error instanceof CheckoutSessionUnavailable;
      const changed = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, sessionId: null,
        requestStartedAt: { not: null }, status: { in: ['PREPARED', 'AMBIGUOUS'] } }, data: {
        ...(error instanceof CheckoutSessionUnavailable ? { sessionId: error.sessionId } : {}),
        status: review ? 'REVIEW' : 'AMBIGUOUS',
        failureCode: review ? 'REVIEW_REQUIRED' : 'PROVIDER_REQUEST_UNCONFIRMED',
      } });
      if (changed.count) await tx.order.update({ where: { id: attempt.orderId }, data: {
        ...(review ? { paymentState: 'REVIEW', paymentHold: true } : {}), paymentRevision: { increment: 1 },
      } });
    });
    if (error instanceof CheckoutSessionUnavailable) throw new PaymentReviewRequired();
    throw error;
  }
}
