import { createHash } from 'node:crypto';
import { Prisma, type PaymentAttempt, type PaymentEvent } from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { getStripeClient } from '@/lib/stripe';
import { providerId, providerPages } from './payment-provider';
import { reconcileOrderPayment } from './payment-reconciliation';

const relevant = (type: string) => type.startsWith('checkout.session.') || type.startsWith('payment_intent.') ||
  type.startsWith('charge.') || type.startsWith('refund.');
const ref = (value: unknown): string | null => typeof value === 'string' && value.length <= 200 ? value : null;
const objectRef = (value: unknown): string | null => ref(typeof value === 'object' && value !== null ? (value as { id?: unknown }).id : value);

/** Persist no addresses, card details, emails, names, evidence or raw payloads.
 * Signature verification belongs to the route before this function is called.
 */
export function minimizedPaymentEvent(event: Stripe.Event) {
  const object = event.data.object as unknown as Record<string, unknown>;
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;
  const objectType = ref(object.object);
  return { objectType, objectId: ref(object.id), orderId: ref(metadata.orderId) ?? ref(object.client_reference_id),
    attemptId: ref(metadata.attemptId), sessionId: objectType === 'checkout.session' ? ref(object.id) : null,
    paymentIntentId: objectType === 'payment_intent' ? ref(object.id) : objectRef(object.payment_intent),
    chargeId: objectType === 'charge' ? ref(object.id) : objectRef(object.charge),
    currency: ref(object.currency), status: ref(object.status), paymentStatus: ref(object.payment_status),
    amountMinor: Number.isSafeInteger(object.amount ?? object.amount_total) ? Number(object.amount ?? object.amount_total) : null,
    receivedMinor: Number.isSafeInteger(object.amount_received) ? Number(object.amount_received) : null };
}

/** A signed delivery is committed before provider lookups. Unique upsert handles
 * simultaneous delivery; digest mismatch never overwrites the original record.
 */
export async function recordSignedPaymentEvent(event: Stripe.Event): Promise<PaymentEvent> {
  if (!ref(event.id) || !ref(event.type)) throw new Error('Invalid signed event identity');
  const data = minimizedPaymentEvent(event);
  const dataDigest = createHash('sha256').update(JSON.stringify({ type: event.type, livemode: event.livemode,
    account: event.account ?? null, created: event.created, data })).digest('hex');
  const record = await prisma.paymentEvent.upsert({ where: { providerEventId: event.id }, update: {}, create: {
    providerEventId: event.id, source: 'SIGNED_WEBHOOK', type: event.type, providerAccountId: ref(event.account),
    livemode: event.livemode, providerCreatedAt: new Date(event.created * 1000), objectId: data.objectId,
    data, dataDigest, status: relevant(event.type) ? 'RECEIVED' : 'IGNORED',
    ...(!relevant(event.type) ? { processedAt: new Date(), outcome: 'UNRELATED_EVENT' } : {}),
  } }).catch(async error => {
    // Prisma can implement an empty-update upsert as read-then-create. Another
    // first delivery may insert between them; read its committed identity and
    // still verify the digest below. Never overwrite it or swallow other errors.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const winner = await prisma.paymentEvent.findUnique({ where: { providerEventId: event.id } });
    if (!winner) throw error;
    return winner;
  });
  if (record.dataDigest !== dataDigest) throw new Error('Signed event identity collision');
  return record;
}

/** Resolve stable references through recorded attempts first, provider metadata
 * only as a fallback hint. Reconciliation still validates every canonical link.
 */
async function resolveEventOrder(record: PaymentEvent): Promise<{ orderId: string; attempt: PaymentAttempt | null } | null> {
  const data = record.data as ReturnType<typeof minimizedPaymentEvent>;
  let attempt = record.attemptId ? await prisma.paymentAttempt.findUnique({ where: { id: record.attemptId } }) : null;
  if (!attempt && data.sessionId) attempt = await prisma.paymentAttempt.findUnique({ where: { sessionId: data.sessionId } });
  if (!attempt && data.paymentIntentId) attempt = await prisma.paymentAttempt.findUnique({ where: { paymentIntentId: data.paymentIntentId } });
  if (!attempt && data.attemptId) attempt = await prisma.paymentAttempt.findUnique({ where: { id: data.attemptId } });
  if (attempt) return { orderId: attempt.orderId, attempt };
  if (data.sessionId) {
    const legacy = await prisma.order.findUnique({ where: { stripeSessionId: data.sessionId }, select: { id: true } });
    if (legacy) return { orderId: legacy.id, attempt: null };
  }
  // Signed hints can identify an unknown payment for operator review. They
  // cannot turn a never-issued session into a known successful attempt.
  let orderHint = data.orderId;
  if (orderHint) {
    const known = await prisma.order.findUnique({ where: { id: orderHint }, select: { id: true } });
    if (known) return { orderId: known.id, attempt: null };
  }
  let intentId = data.paymentIntentId;
  if (!intentId && data.chargeId) intentId = providerId((await getStripeClient().charges.retrieve(data.chargeId)).payment_intent);
  if (intentId) {
    const intent = await getStripeClient().paymentIntents.retrieve(intentId);
    const attemptHint = ref(intent.metadata?.attemptId);
    if (attemptHint) {
      const known = await prisma.paymentAttempt.findUnique({ where: { id: attemptHint } });
      if (known) return { orderId: known.orderId, attempt: known };
    }
    // Legacy intents carry no order metadata. Bind through the provider's own
    // intent→session link and our recorded session→order reference, never hints,
    // so a refund/dispute on a pre-migration payment still reaches its order.
    const sessions = await providerPages(cursor => getStripeClient().checkout.sessions.list({
      payment_intent: intentId!, limit: 100, starting_after: cursor,
    }));
    for (const session of sessions) {
      const legacy = await prisma.order.findUnique({ where: { stripeSessionId: session.id }, select: { id: true } });
      if (legacy) return { orderId: legacy.id, attempt: null };
    }
    orderHint = orderHint ?? ref(intent.metadata?.orderId);
  }
  if (!orderHint) return null;
  const order = await prisma.order.findUnique({ where: { id: orderHint }, select: { id: true } });
  return order ? { orderId: order.id, attempt: null } : null;
}

/** Retry failures against the same durable delivery. A received financial event
 * places an immediate hold before canonical I/O, including refund/dispute events
 * whose provider fetch fails. No transaction remains open across provider calls.
 */
export async function processSignedPaymentEvent(event: Stripe.Event) {
  const record = await recordSignedPaymentEvent(event);
  if (['IGNORED', 'PROCESSED', 'REVIEW'].includes(record.status)) return record;
  try {
    const match = await resolveEventOrder(record);
    if (!match) {
      // A concurrent delivery may have matched and reconciled this same event
      // while our lookup found nothing. Never clobber its committed outcome.
      await prisma.paymentEvent.updateMany({ where: { id: record.id, orderId: null, attemptId: null,
        status: { in: ['RECEIVED', 'FAILED', 'UNMATCHED'] } }, data: {
        status: 'UNMATCHED', processedAt: new Date(), outcome: 'UNKNOWN_ORDER_OR_ATTEMPT',
      } });
      return prisma.paymentEvent.findUniqueOrThrow({ where: { id: record.id } });
    }
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${match.orderId} FOR UPDATE`;
      const current = await tx.paymentEvent.findUniqueOrThrow({ where: { id: record.id } });
      if (['PROCESSED', 'REVIEW'].includes(current.status)) return;
      await tx.paymentEvent.update({ where: { id: record.id }, data: { orderId: match.orderId,
        attemptId: match.attempt?.id ?? null, status: 'RECEIVED', processedAt: null } });
      await tx.order.update({ where: { id: match.orderId }, data: { paymentHold: true, paymentRevision: { increment: 1 } } });
    });
    await reconcileOrderPayment(match.orderId);
    return prisma.paymentEvent.findUniqueOrThrow({ where: { id: record.id } });
  } catch (error) {
    // A concurrent delivery may have completed this exact event while our
    // snapshot lost the revision race. Its committed outcome is authoritative.
    const completed = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: record.id } });
    if (['PROCESSED', 'REVIEW'].includes(completed.status)) return completed;
    // Do not overwrite another delivery's successfully published outcome.
    await prisma.paymentEvent.updateMany({ where: { id: record.id, status: { in: ['RECEIVED', 'FAILED', 'UNMATCHED'] } },
      data: { status: 'FAILED', processedAt: new Date(), outcome: 'CANONICAL_RECONCILIATION_FAILED' } });
    throw error;
  }
}
