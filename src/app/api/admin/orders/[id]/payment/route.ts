import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { isStripeConfigured } from '@/lib/stripe';
import { consumeRateLimit, tooManyRequests } from '@/lib/rate-limit';
import { PaymentReviewRequired } from '@/lib/orders/payment-attempts';
import { recordAdminReconciliation, releasePaymentHold } from '@/lib/orders/payment-reconciliation';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('RECONCILE') }).strict(),
  z.object({ action: z.literal('RELEASE_HOLD'), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    explanation: z.string().trim().min(10).max(1000), confirmed: z.literal(true) }).strict(),
]);

async function currentOperator() {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== 'ADMIN') return null;
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } });
  return user?.role === 'ADMIN' ? session.user.id : null;
}

/** Read-only history never fetches providers or exposes frozen Checkout requests. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await currentOperator()) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers });
  const { id } = await params;
  const order = await prisma.order.findUnique({ where: { id }, select: {
    id: true, status: true, paymentState: true, paymentHold: true, paymentSummary: true,
    currency: true, expectedMinorAmount: true, paidAt: true, manualSettlement: true,
    paymentAttempts: { orderBy: { sequence: 'asc' }, select: {
      id: true, sequence: true, status: true, expectedMinorAmount: true, currency: true, livemode: true,
      providerAccountId: true, sessionId: true, paymentIntentId: true, requestStartedAt: true,
      providerSnapshot: true, failureCode: true, createdAt: true, updatedAt: true,
    } },
    paymentEvents: { orderBy: { createdAt: 'desc' }, select: {
      id: true, providerEventId: true, source: true, type: true, status: true, data: true,
      outcome: true, createdAt: true, processedAt: true,
    } },
  } });
  return order ? NextResponse.json({ order }, { headers })
    : NextResponse.json({ error: 'Order not found' }, { status: 404, headers });
}

/** Reconciliation only reads Stripe. Refunds remain a Stripe Dashboard action. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const operatorId = await currentOperator();
  if (!operatorId) return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers });
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers }); }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'A valid action and explicit current-facts review are required.' }, { status: 400, headers });
  const { id } = await params;
  if (!await prisma.order.findUnique({ where: { id }, select: { id: true } })) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404, headers });
  }
  if (!isStripeConfigured()) return NextResponse.json({ error: 'Payment reconciliation is not configured.' }, { status: 503, headers });
  const limit = await consumeRateLimit(`payment-review:admin:${operatorId}`, { limit: 30, windowMs: 60 * 60_000 });
  if (!limit.allowed) return tooManyRequests(limit, 'Too many reconciliation requests. Try again later.');
  try {
    if (parsed.data.action === 'RELEASE_HOLD') {
      await releasePaymentHold(id, operatorId, parsed.data.fingerprint, parsed.data.explanation);
      return NextResponse.json({ released: true }, { headers });
    }
    const result = await recordAdminReconciliation(id, operatorId);
    return NextResponse.json({ paymentState: result.state, paymentHold: result.hold, settled: result.settled }, { headers });
  } catch (error) {
    if (error instanceof PaymentReviewRequired) return NextResponse.json({ error: error.message, code: error.code }, { status: 409, headers });
    return NextResponse.json({ error: 'Canonical payment state could not be confirmed. History is retained; reconcile again before fulfillment.' }, { status: 502, headers });
  }
}
