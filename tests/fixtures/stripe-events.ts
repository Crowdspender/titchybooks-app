import Stripe from 'stripe';
import { NextRequest } from 'next/server';

/**
 * Helpers for driving /api/stripe/webhook with genuinely signed payloads.
 *
 * The handler derives authenticity from the signature alone, so a test cannot
 * talk to it with a plain JSON body: the payload has to be signed with the same
 * secret the handler verifies against.
 */

export const WEBHOOK_SECRET = 'whsec_integration_test_secret';

export interface CompletedSessionOverrides {
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required';
  amountTotal?: number;
  currency?: string;
}

/** A `checkout.session.completed` event shaped like the ones Stripe sends. */
export function completedEvent(
  orderId: string,
  sessionId: string,
  overrides: CompletedSessionOverrides = {},
) {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    object: 'event' as const,
    api_version: '2024-06-20' as const,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: 'checkout.session.completed' as const,
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session' as const,
        client_reference_id: orderId,
        metadata: { orderId },
        payment_status: overrides.paymentStatus ?? ('paid' as const),
        amount_total: overrides.amountTotal ?? 4000,
        currency: overrides.currency ?? 'huf',
      },
    },
  };
}

export function signatureFor(payload: string, secret = WEBHOOK_SECRET) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

export function signedRequest(payload: string, signature: string) {
  return new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: payload,
  });
}

/** A ready-to-post request whose body and signature agree. */
export function signedEventRequest(event: unknown) {
  const payload = JSON.stringify(event);
  return signedRequest(payload, signatureFor(payload));
}
