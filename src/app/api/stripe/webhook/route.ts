import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { getStripeClient } from "@/lib/stripe";
import {
  createVaultEntryForOrder,
  transitionOrderToPaid,
} from "@/lib/orders/lifecycle";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook for Checkout sessions. Authenticity comes solely from the
 * signature (constructed against STRIPE_WEBHOOK_SECRET) - no session cookie
 * or bearer token is involved, and the same-origin proxy pre-check lets
 * this through because Stripe sends no Origin header.
 *
 * Idempotency: Stripe retries events, and duplicate deliveries must be
 * harmless. transitionOrderToPaid is a conditional update (exactly one
 * winner) and the vault entry creation dedupes by orderId.
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
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCompletedSession(session);
        break;
      }
      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        console.info(
          JSON.stringify({
            event: "checkout-session-expired",
            orderId: session.metadata?.orderId,
            sessionId: session.id,
          }),
        );
        break;
      }
      default:
        // Unhandled event types are acknowledged, not retried forever.
        break;
    }
  } catch (err) {
    // Non-2xx makes Stripe retry the delivery with backoff.
    console.error(
      JSON.stringify({
        event: "stripe-webhook-error",
        eventId: event.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return NextResponse.json({ error: "Processing failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

async function handleCompletedSession(session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.orderId ?? session.client_reference_id;
  if (!orderId) {
    console.warn(JSON.stringify({ event: "stripe-webhook-no-order", sessionId: session.id }));
    return;
  }
  if (session.payment_status !== "paid") {
    console.warn(
      JSON.stringify({
        event: "stripe-webhook-unpaid-completion",
        orderId,
        paymentStatus: session.payment_status,
      }),
    );
    return;
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, stripeSessionId: true },
  });
  if (!order) {
    // Signed by our secret, so this can only be an event for an order that
    // was cancelled and deleted, or a metadata mix-up. Do not create anything.
    console.warn(
      JSON.stringify({ event: "stripe-webhook-unknown-order", orderId, sessionId: session.id }),
    );
    return;
  }
  if (order.stripeSessionId !== session.id) {
    // A newer session was issued for the same order but the buyer completed
    // this older one - the payment is real (signature-verified), so proceed
    // and surface it for reconciliation.
    console.warn(
      JSON.stringify({
        event: "stripe-webhook-stale-session",
        orderId,
        sessionId: session.id,
        storedSessionId: order.stripeSessionId,
      }),
    );
  }

  await prisma.$transaction(async (tx) => {
    const result = await transitionOrderToPaid(tx, order.id);
    // Also runs for "already-paid" as a vault-recovery path (e.g. an admin
    // marked the order paid but the vault entry creation failed).
    if (result.ok || result.reason === "already-paid") {
      await createVaultEntryForOrder(tx, order.id);
    }
    console.info(
      JSON.stringify({
        event: "order-paid-via-webhook",
        orderId: order.id,
        sessionId: session.id,
        transition: result.ok ? "applied" : (result.reason ?? "skipped"),
      }),
    );
  });
}
