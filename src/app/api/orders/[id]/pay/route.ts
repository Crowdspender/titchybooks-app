import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { createCheckoutSession, isStripeConfigured } from "@/lib/stripe";
import { isCurrency, type Currency } from "@/lib/pricing/currency";
import { loadPricingConfig } from "@/lib/pricing/config";

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
    include: { submission: { select: { title: true } } },
  });
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (order.userId !== session.user.id && session.user.role !== "ADMIN") {
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

  const cfg = await loadPricingConfig();
  const currency: Currency = isCurrency(order.currency) ? order.currency : "HUF";

  try {
    const { url, sessionId } = await createCheckoutSession({
      orderId: order.id,
      submissionTitle: order.submission?.title ?? "TitchyBook",
      amountHuf: order.totalHuf,
      currency,
      rates: cfg.currencyRates,
      customerEmail: session.user.email ?? null,
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { stripeSessionId: sessionId },
    });
    return NextResponse.json({ checkoutUrl: url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Payment session creation failed";
    console.error(
      JSON.stringify({ event: "checkout-session-failed", orderId: order.id, error: message }),
    );
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
