import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";
import { processSignedPaymentEvent } from "@/lib/orders/payment-events";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook for Checkout, payments, refunds, and disputes. Authenticity comes solely from the
 * signature (constructed against STRIPE_WEBHOOK_SECRET) - no session cookie
 * or bearer token is involved, and the same-origin proxy pre-check lets
 * this through because Stripe sends no Origin header.
 *
 * Signed deliveries are durably minimized before canonical provider reads.
 * Amount/context/reference checks and settlement share one revision-fenced
 * transaction; payment history never overwrites physical fulfillment.
 */
export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(JSON.stringify({ event: "stripe-webhook-misconfigured" }));
    return NextResponse.json(
      { error: "Webhook endpoint is not configured" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  // constructEvent needs the exact raw bytes that Stripe signed.
  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = getStripeClient().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    await processSignedPaymentEvent(event);
  } catch {
    // Non-2xx makes Stripe retry the delivery with backoff.
    console.error(
      JSON.stringify({
        event: "stripe-webhook-error",
        eventId: event.id,
        outcome: "canonical-reconciliation-failed",
      }),
    );
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
