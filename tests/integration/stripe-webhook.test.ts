import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db, cleanupFixtures, trackPaymentEvent } from '../fixtures/database';
import { createPendingOrderWithUser } from '../fixtures/orders';
import {
  WEBHOOK_SECRET,
  completedEvent,
  signatureFor,
  signedEventRequest,
  signedRequest,
  installSyntheticWebhookProvider,
} from '../fixtures/stripe-events';
import { POST as webhook } from '@/app/api/stripe/webhook/route';

beforeAll(() => {
  // Real cryptographic signatures with synthetic canonical provider reads.
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_integration_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
});
beforeEach(installSyntheticWebhookProvider);
afterEach(cleanupFixtures);

/** Awaiting payment, carrying the session id the webhook will be told about. */
function createPendingOrder(vaultAddOn: boolean) {
  return createPendingOrderWithUser({ vaultAddOn, stripeSessionId: 'cs_test_session_1' });
}

describe('Stripe checkout webhook -> order PAID transition', () => {
  it('marks the order PAID, stamps paidAt, and creates the vault entry', async () => {
    const { order } = await createPendingOrder(true);

    const res = await webhook(
      signedEventRequest(completedEvent(order.id, order.stripeSessionId!)),
    );
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
    const signature = signatureFor(payload);
    // A fresh request per delivery: a body stream can only be read once.
    const delivery = () => signedRequest(payload, signature);

    expect((await webhook(delivery())).status).toBe(200);
    expect((await webhook(delivery())).status).toBe(200);

    expect(await db.vaultEntry.count({ where: { orderId: order.id } })).toBe(1);
    expect(await db.order.count({ where: { id: order.id, status: 'PAID' } })).toBe(1);
  });

  it('rejects unsigned or badly signed payloads', async () => {
    const { order } = await createPendingOrder(false);
    const event = completedEvent(order.id, order.stripeSessionId!);
    const payload = JSON.stringify(event);

    const noSig = await webhook(
      new NextRequest('http://localhost/api/stripe/webhook', { method: 'POST', body: payload }),
    );
    expect(noSig.status).toBe(400);

    const badSig = await webhook(signedRequest(payload, signatureFor(payload + 'tampered')));
    expect(badSig.status).toBe(400);

    // Order untouched.
    const still = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(still.status).toBe('PENDING_PAYMENT');
    expect(still.paidAt).toBeNull();
    expect(await db.paymentEvent.count({ where: { orderId: order.id } })).toBe(0);
    // A pre-verification write with a null order link would evade the count
    // above; the invalid delivery's own event id must not exist at all. The
    // unmatched test below stays the control: a VALID signature may unlink.
    expect(await db.paymentEvent.findUnique({ where: { providerEventId: event.id } })).toBeNull();
  });

  it('retains unmatched events for orders that do not exist', async () => {
    const event = completedEvent('nonexistent-order-id', 'cs_test_orphan');
    const res = await webhook(signedEventRequest(event));
    expect(res.status).toBe(200);
    const record = await db.paymentEvent.findUniqueOrThrow({ where: { providerEventId: event.id } });
    trackPaymentEvent(record.id);
    expect(record).toMatchObject({ status: 'UNMATCHED', orderId: null });
  });

  it('does not transition on unpaid completion or unknown sessions', async () => {
    const { order } = await createPendingOrder(false);
    const res = await webhook(
      signedEventRequest(
        completedEvent(order.id, 'cs_test_never_issued', { paymentStatus: 'unpaid' }),
      ),
    );
    expect(res.status).toBe(200);
    const still = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(still.status).toBe('PENDING_PAYMENT');
  });
});
