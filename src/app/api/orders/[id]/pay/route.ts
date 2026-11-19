import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isStripeConfigured } from "@/lib/stripe";
import { preparePaymentAttempt, issuePaymentAttempt, PaymentReviewRequired } from "@/lib/orders/payment-attempts";
import { reconcileOrderPayment } from "@/lib/orders/payment-reconciliation";
import { isCurrency } from "@/lib/pricing/currency";
import { loadCheckoutPricingConfig } from "@/lib/pricing/config";
import { assertChargeAmount } from "@/lib/pricing/charge";
import { assertDestinationWeight, loadShippingPolicy, ManualQuoteRequired, resolveDestination } from "@/lib/pricing/destination";
import type { PreviewOffer } from "@/lib/pricing/offer";
import { ZONES, type Zone } from "@/lib/pricing/constants";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/[id]/pay - (re)issue a Stripe Checkout session for an
 * order that is still awaiting payment (retry after an abandoned or failed
 * checkout, or when session creation failed at order time).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await consumeRateLimit(`pay:user:${session.user.id}`, {
    limit: 30,
    windowMs: 60 * 60_000,
  });
  if (!rl.allowed) {
    return tooManyRequests(rl, "Too many payment attempts - please try again later.");
  }

  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id },
    include: { submission: { select: { title: true } }, user: { select: { email: true } } },
  });
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (order.userId !== session.user.id && (session.user.role !== "ADMIN" ||
      (await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } }))?.role !== "ADMIN")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (order.status !== "PENDING_PAYMENT") {
    return NextResponse.json(
      { error: `Order is not awaiting payment (status: ${order.status})` },
      { status: 400 },
    );
  }
  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "Online payment is not configured for this deployment" },
      { status: 503 },
    );
  }

  const review = () => NextResponse.json({ error: "The original charge cannot safely be retried. Contact us to review replacement terms; this order and its history are retained.",
    code: "PAYMENT_REVIEW_REQUIRED", contactUrl: "/contact?topic=other" }, { status: 409 });
  if (!isCurrency(order.currency)) return review();
  const currency = order.currency;
  if (order.expectedMinorAmount === null && !order.stripeSessionId) return review();

  try {
    const policy = loadShippingPolicy();
    if (!policy) throw new ManualQuoteRequired();
    const snapshot = order.quoteSnapshot as unknown as PreviewOffer | null;
    if (order.requestKey && (!snapshot || snapshot.version !== 1 || snapshot.userId !== order.userId ||
        snapshot.inputs?.submissionId !== order.submissionId || snapshot.charge?.currency !== currency ||
        snapshot.charge?.amountMinor !== order.expectedMinorAmount || snapshot.calculation?.totalHuf !== order.totalHuf ||
        !order.fxRate?.eq(snapshot.charge.fxRate) || !order.quoteAcceptedAt)) return review();
    // Frozen offers use their original config, including booklet weight; current FX is irrelevant.
    const cfg = order.requestKey && snapshot ? snapshot.pricingConfig : await loadCheckoutPricingConfig();
    const assertedZone = (ZONES as readonly string[]).includes(order.zone) ? order.zone as Zone
      : order.zone === "HU" ? "hungary" : undefined;
    if (!assertedZone) return review();
    const destination = resolveDestination(order.countryCode, order.postalCode, order.vaultAddOn, cfg, policy, assertedZone);
    assertDestinationWeight(destination, order.weightGrams);
    const currentRequiredWeight = (order.quantity + destination.shippedExtraCopies) * cfg.weightPerBookGrams + destination.packagingWeightGrams;
    if (currentRequiredWeight > order.weightGrams) throw new ManualQuoteRequired("Shipping weight assumptions changed. Contact us for review; your accepted price is retained.");

    const latest = await prisma.paymentAttempt.findFirst({ where: { orderId: order.id }, orderBy: { sequence: "desc" } });
    // An unpublished ambiguous call must recover its recorded key directly, not
    // turn an absent session into a review hold or issue a successor request.
    const recoverable = latest && !latest.sessionId && ["PREPARED", "AMBIGUOUS"].includes(latest.status);
    if (!recoverable && (latest || order.stripeSessionId)) {
      const result = await reconcileOrderPayment(order.id);
      if (result.hold) return review();
      if (result.state === "PAID" || result.state === "MANUAL_PAID" || result.state === "PROCESSING") {
        return NextResponse.json({ paymentState: result.state, checkoutUrl: null },
          { headers: { "Cache-Control": "private, no-store" } });
      }
      if (!["UNPAID", "FAILED"].includes(result.state ?? "")) return review();
    }
    const attempt = await preparePaymentAttempt(order.id, order.submission?.title ?? "TitchyBook", order.user.email);
    assertChargeAmount(attempt.expectedMinorAmount, currency);
    const issued = await issuePaymentAttempt(attempt.id);
    return NextResponse.json({ checkoutUrl: issued.url, amountMinor: attempt.expectedMinorAmount,
      currency, attemptId: attempt.id }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PaymentReviewRequired || (error instanceof Error && error.message === "Provider session needs review")) return review();
    if (error instanceof ManualQuoteRequired) return NextResponse.json({ error: error.message, code: error.code,
      contactUrl: "/contact?topic=unlisted_region" }, { status: 422 });
    console.error(JSON.stringify({ event: "checkout-session-failed", orderId: order.id }));
    return NextResponse.json({ error: "Payment is unavailable. Your accepted amount is unchanged; check the order page before retrying." }, { status: 502 });
  }
}
