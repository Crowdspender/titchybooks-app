import type { OrderStatus } from '@prisma/client';
import { createDraft, createUser, db } from './database';

/**
 * Order fixtures for the payment paths.
 *
 * Every column the Stripe webhook, the checkout retry route and the vault
 * side-effect read is set explicitly, so a test never depends on a schema
 * default drifting underneath it.
 */
export interface OrderFixtureOverrides {
  status?: OrderStatus;
  /** Unique per order; left null (which Postgres allows repeatedly) by default. */
  stripeSessionId?: string | null;
  vaultAddOn?: boolean;
  vaultFeeHuf?: number;
  totalHuf?: number;
  currency?: string;
  /** Title on the related submission, surfaced as the Checkout line item. */
  title?: string | null;
}

export async function createOrderForUser(userId: string, overrides: OrderFixtureOverrides = {}) {
  const { title, ...order } = overrides;
  const vaultAddOn = order.vaultAddOn ?? false;
  const submission = await createDraft(userId);
  if (title !== undefined) {
    await db.submission.update({ where: { id: submission.id }, data: { title } });
  }
  const created = await db.order.create({
    data: {
      userId,
      submissionId: submission.id,
      quantity: 1,
      zone: 'HU',
      weightGrams: 200,
      shippingBand: 0,
      vaultAddOn,
      vaultFeeHuf: order.vaultFeeHuf ?? (vaultAddOn ? 2000 : 0),
      unitPriceHuf: 3000,
      printCostHuf: 3000,
      shippingCostHuf: 1000,
      totalHuf: order.totalHuf ?? (vaultAddOn ? 6000 : 4000),
      currency: order.currency ?? 'HUF',
      status: order.status ?? 'PENDING_PAYMENT',
      pricingConfigVersion: 1,
      stripeSessionId: order.stripeSessionId ?? null,
      recipientName: 'Test Recipient',
      line1: 'Test Street 1',
      city: 'Budapest',
      postalCode: '1000',
      countryCode: 'HU',
    },
  });
  return { submission, order: created };
}

/** A pending order owned by a freshly created user. */
export async function createPendingOrderWithUser(overrides: OrderFixtureOverrides = {}) {
  const user = await createUser();
  const created = await createOrderForUser(user.id, overrides);
  return { user, ...created };
}
