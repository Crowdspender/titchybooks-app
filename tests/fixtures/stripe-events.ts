import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { vi } from 'vitest';
import type { PaymentAttempt } from '@prisma/client';
import * as stripeService from '@/lib/stripe';
import * as paymentProvider from '@/lib/orders/payment-provider';
import type { CanonicalPaymentProof } from '@/lib/orders/payment-state';
import { db } from './database';

/**
 * Helpers for driving /api/stripe/webhook with genuinely signed payloads.
 *
 * The handler derives authenticity from the signature alone, so a test cannot
 * talk to it with a plain JSON body: the payload has to be signed with the same
 * secret the handler verifies against.
 */

export const WEBHOOK_SECRET = 'whsec_integration_test_secret';
const canonicalSessions = new Map<string, ReturnType<typeof completedEvent>['data']['object']>();

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
  const event = {
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
  canonicalSessions.set(sessionId, event.data.object);
  return event;
}

/** SDK signatures remain real; provider reads alone are synthetic. Gateway
 * pagination/reference validation is covered independently in its unit suite. */
export function installSyntheticWebhookProvider() {
  vi.spyOn(stripeService, 'retrieveStripeAccountContext').mockResolvedValue({ accountId: 'acct_fixture', livemode: false });
  vi.spyOn(stripeService, 'retrieveOrderCheckoutSession').mockImplementation(async (id, orderId, currency) => {
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    const stored = canonicalSessions.get(id);
    const known = stored?.client_reference_id === orderId ? stored : undefined;
    return { id, livemode: false, mode: 'payment', metadata: { orderId }, client_reference_id: orderId,
      amount_total: known?.amount_total ?? order.expectedMinorAmount ?? 4000, currency: currency.toLowerCase(),
      status: known?.payment_status === 'paid' ? 'complete' : 'expired', payment_status: known?.payment_status ?? 'unpaid', url: null,
    } as unknown as Awaited<ReturnType<typeof stripeService.retrieveOrderCheckoutSession>>;
  });
  vi.spyOn(paymentProvider, 'readCanonicalAttempt').mockImplementation(async attempt => {
    const canonical = await stripeService.retrieveOrderCheckoutSession(attempt.sessionId!, attempt.orderId, attempt.currency as 'HUF' | 'EUR' | 'GBP');
    return syntheticCanonicalProof(attempt, canonical);
  });
}

export function syntheticCanonicalProof(attempt: PaymentAttempt, session: Stripe.Checkout.Session): CanonicalPaymentProof {
  const status = session.payment_status === 'paid' ? 'SUCCEEDED' : session.status === 'open' ? 'OPEN'
    : session.status === 'expired' ? 'EXPIRED' : session.status === 'complete' ? 'PROCESSING' : 'REVIEW';
  return { attemptId: attempt.id, sessionId: session.id, paymentIntentId: status === 'SUCCEEDED' ? `pi_${session.id}` : null,
    expectedAccountId: attempt.providerAccountId, accountId: attempt.providerAccountId ?? 'acct_fixture',
    expectedLivemode: attempt.livemode, livemode: session.livemode, expectedMinorAmount: attempt.expectedMinorAmount,
    amountMinor: session.amount_total!, currency: session.currency!.toUpperCase(), status,
    receivedMinor: status === 'SUCCEEDED' ? session.amount_total! : 0, refunds: [], disputes: [], reviewReasons: [] };
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
