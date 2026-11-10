import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { NextRequest } from 'next/server';
import { db, createUser, createDraft, cleanupFixtures } from '../fixtures/database';
import { POST as webhook } from '@/app/api/stripe/webhook/route';

const WEBHOOK_SECRET = 'whsec_integration_test_secret';

beforeAll(() => {
  // getStripeClient() needs *a* key; no network calls happen because the
  // handler only uses webhooks.constructEvent (pure crypto).
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_integration_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
});
afterEach(cleanupFixtures);

async function createPendingOrder(vaultAddOn: boolean) {
  const user = await createUser();
  const submission = await createDraft(user.id);
  const order = await db.order.create({
    data: {
      userId: user.id,
      submissionId: submission.id,
      quantity: 1,
      zone: 'HU',
      weightGrams: 200,
      shippingBand: 0,
      vaultAddOn,
      vaultFeeHuf: vaultAddOn ? 2000 : 0,
      unitPriceHuf: 3000,
      printCostHuf: 3000,
      shippingCostHuf: 1000,
      totalHuf: vaultAddOn ? 6000 : 4000,
      currency: 'HUF',
      status: 'PENDING_PAYMENT',
      pricingConfigVersion: 1,
      stripeSessionId: 'cs_test_session_1',
      recipientName: 'Test Recipient',
      line1: 'Test Street 1',
      city: 'Budapest',
      postalCode: '1000',
      countryCode: 'HU',
    },
  });
  return { user, submission, order };
}

function completedEvent(orderId: string, sessionId: string) {
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
        payment_status: 'paid' as const,
        amount_total: 4000,
        currency: 'huf',
      },
    },
  };
}

function signedRequest(payload: string, signature: string) {
  return new NextRequest('http://localhost/api/stripe/webhook', {
    method: 'POST',
    headers: { 'stripe-signature': signature },
    body: payload,
  });
}

function headerFor(payload: string) {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
}

describe('Stripe checkout webhook -> order PAID transition', () => {
  it('marks the order PAID, stamps paidAt, and creates the vault entry', async () => {
    const { order } = await createPendingOrder(true);
    const event = completedEvent(order.id, order.stripeSessionId!);
    const payload = JSON.stringify(event);

    const res = await webhook(signedRequest(payload, headerFor(payload)));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });

    const paid = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(paid.status).toBe('PAID');
    expect(paid.paidAt).not.toBeNull();

    const vault = await db.vaultEntry.findFirst({ where: { orderId: order.id } });
    expect(vault).not.toBeNull();
    expect(vault?.status).toBe('STORED');
    expect(vault?.publicConsent).toBe(false); // consent-gated by default
  });

  it('is idempotent across event retries (no duplicate vault entries)', async () => {
    const { order } = await createPendingOrder(true);
    const payload = JSON.stringify(completedEvent(order.id, order.stripeSessionId!));
    const signature = headerFor(payload);

    expect((await webhook(signedRequest(payload, signature))).status).toBe(200);
    expect((await webhook(signedRequest(payload, signature))).status).toBe(200);

    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.order.count({ where: { id: order.id, status: 'PAID' } })).toBe(1);
  });

  it('rejects unsigned or badly signed payloads', async () => {
    const { order } = await createPendingOrder(false);
    const payload = JSON.stringify(completedEvent(order.id, order.stripeSessionId!));

    const noSig = await webhook(
      new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', body: payload }),
    );
    expect(noSig.status).toBe(400);

    const badSig = await webhook(signedRequest(payload, headerFor(payload + 'tampered')));
    expect(badSig.status).toBe(400);

    // Order untouched.
    const still = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(still.status).toBe('PENDING_PAYMENT');
    expect(still.paidAt).toBeNull();
  });

  it('ignores events for orders that do not exist', async () => {
    const payload = JSON.stringify(completedEvent('nonexistent-order-id', 'cs_test_orphan'));
    const res = await webhook(signedRequest(payload, headerFor(payload)));
    // Acknowledged so Stripe stops retrying an event we can never apply.
    expect(res.status).toBe(200);
  });

  it('does not transition on unpaid completion or unknown sessions', async () => {
    const { order } = await createPendingOrder(false);
    const event = completedEvent(order.id, 'cs_test_never_issued');
    (event.data.object as { payment_status: string }).payment_status = 'unpaid';
    const payload = JSON.stringify(event);

    const res = await webhook(signedRequest(payload, headerFor(payload)));
    expect(res.status).toBe(200);
    const still = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(still.status).toBe('PENDING_PAYMENT');
  });
});
