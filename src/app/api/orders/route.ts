import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isStripeConfigured } from "@/lib/stripe";
import { preparePaymentAttempt, issuePaymentAttempt, PaymentReviewRequired } from "@/lib/orders/payment-attempts";
import { createOrderInputSchema } from "@/lib/pricing/schema";
import { acceptOrderQuote, findOrderReplay, OrderEligibilityError, OrderRequestConflict } from "@/lib/orders/accepted-quote";
import { ManualQuoteRequired } from "@/lib/pricing/destination";
import { OfferReviewRequired } from "@/lib/pricing/offer";

export const dynamic = "force-dynamic";


export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orders = await prisma.order.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: {
      submission: { select: { id: true, title: true, status: true } },
    },
  });

  return NextResponse.json({ orders });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // A separate request budget bounds parsing and replay lookups even for
  // invalid bodies or users already at the new-order cap. Exact replays stay
  // exempt from the lower new-order limit below.
  const budget = await consumeRateLimit(`order-request:user:${session.user.id}`, { limit: 60, windowMs: 60 * 60_000 });
  if (!budget.allowed) return tooManyRequests(budget, "Too many order requests - please try again later.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message, issues: parsed.error.issues },
      { status: 400 }
    );
  }

  let accepted;
  try {
    const replay = await findOrderReplay(session.user.id, parsed.data);
    if (replay) return NextResponse.json({ order: replay, checkoutUrl: null, replayed: true },
      { headers: { "Cache-Control": "private, no-store" } });
    const rl = await consumeRateLimit(`order:user:${session.user.id}`, { limit: 10, windowMs: 60 * 60_000 });
    if (!rl.allowed) return tooManyRequests(rl, "Too many order attempts - please try again later.");
    accepted = await acceptOrderQuote(session.user.id, parsed.data);
  } catch (error) {
    if (error instanceof OrderRequestConflict) {
      // Definitive rejection: the client must discard the saved request.
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    if (error instanceof OrderEligibilityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ManualQuoteRequired || error instanceof OfferReviewRequired) {
      return NextResponse.json({ error: error.message, code: error.code, contactUrl: "/contact?topic=unlisted_region" },
        { status: error instanceof ManualQuoteRequired ? 422 : 409 });
    }
    // A response/commit failure is ambiguous: keep the same request key on retry.
    return NextResponse.json({ error: "Order outcome is uncertain. Retry the same request or check your orders before starting another." }, { status: 503 });
  }
  const { order, created, title } = accepted;
  if (!created) return NextResponse.json({ order, checkoutUrl: null, replayed: true },
    { headers: { "Cache-Control": "private, no-store" } });

  // Mint a Stripe Checkout session when configured. A Stripe failure must
  // not lose the order: it stays PENDING_PAYMENT and can be paid later via
  // POST /api/orders/[id]/pay.
  let checkoutUrl: string | null = null;
  let paymentError: string | undefined;
  if (isStripeConfigured()) {
    try {
      const attempt = await preparePaymentAttempt(order.id, title, session.user.email);
      const issued = await issuePaymentAttempt(attempt.id);
      checkoutUrl = issued.url;
    } catch (error) {
      paymentError = error instanceof PaymentReviewRequired ? error.message
        : "Payment page unavailable. Your accepted charge and payment attempt are retained; check the order page before retrying.";
      console.error(JSON.stringify({ event: "checkout-session-failed", orderId: order.id }));
    }
  }

  // A failed refresh must not discard the committed order or its checkout URL:
  // the acceptance row is authoritative, and an unstructured throw here would
  // leave a same-key replay unable to recover the URL. Never re-run acceptance
  // or Checkout issuance.
  let confirmed = order;
  try {
    confirmed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  } catch {
    console.error(JSON.stringify({ event: "order-refresh-failed", orderId: order.id }));
  }
  return NextResponse.json(
    { order: confirmed, checkoutUrl, ...(paymentError ? { paymentError } : {}) },
    { status: 201, headers: { "Cache-Control": "private, no-store" } },
  );
}
