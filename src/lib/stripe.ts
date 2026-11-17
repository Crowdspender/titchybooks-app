import Stripe from "stripe";
import {
  convertFromHuf,
  type Currency,
  type CurrencyRates,
} from "./pricing/currency";

/**
 * Stripe Checkout integration. Cards never touch our servers: we create a
 * hosted Checkout session, redirect the buyer, and confirm payment via the
 * signed webhook at /api/stripe/webhook.
 */

let client: Stripe | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  if (!client) {
    client = new Stripe(key, { typescript: true });
  }
  return client;
}

// Every supported currency (HUF, EUR, GBP) charges in hundredths on Stripe:
// HUF is zero-decimal only for payouts, not for charges. Sending whole forint
// would undercharge by 100x.

// Stripe minimum charge per currency, in its smallest chargeable unit
// (HUF 175.00 Ft = 17500 filler).
const MINIMUM_AMOUNTS: Partial<Record<Currency, number>> = {
  HUF: 17500,
  EUR: 50,
  GBP: 30,
};

/**
 * Convert the authoritative HUF total into the Stripe `unit_amount` for the
 * order's display/charge currency, using the same coarse rates the UI shows
 * (PricingConfig.currencyRates). Throws if the amount is below Stripe's
 * minimum charge for that currency.
 */
export function toStripeAmount(
  amountHuf: number,
  currency: Currency,
  rates?: Partial<CurrencyRates> | null,
): number {
  const converted = convertFromHuf(amountHuf, currency, rates);
  const units = Math.round(converted * 100);
  const minimum = MINIMUM_AMOUNTS[currency] ?? 1;
  if (units < minimum) {
    throw new Error(
      `Order total is below the minimum chargeable amount in ${currency}`,
    );
  }
  return units;
}

export interface CheckoutSessionInput {
  orderId: string;
  submissionTitle: string;
  amountHuf: number;
  currency: Currency;
  rates?: Partial<CurrencyRates> | null;
  customerEmail?: string | null;
}

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

export async function createCheckoutSession(
  input: CheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  const stripe = getStripeClient();
  // NEXTAUTH_URL is the canonical public origin (set in every environment);
  // relative redirects would be rejected by Stripe.
  const appUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: input.orderId,
    customer_email: input.customerEmail ?? undefined,
    // The webhook matches this id against Order.stripeSessionId, so events
    // for sessions we never issued are ignored.
    metadata: { orderId: input.orderId },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.currency.toLowerCase(),
          unit_amount: toStripeAmount(input.amountHuf, input.currency, input.rates),
          product_data: {
            name: "TitchyBook printed book",
            description: input.submissionTitle,
          },
        },
      },
    ],
    success_url: `${appUrl}/dashboard/orders/${input.orderId}?checkout=success`,
    cancel_url: `${appUrl}/dashboard/orders/${input.orderId}?checkout=canceled`,
  });

  if (!session.url || !session.id) {
    throw new Error("Stripe did not return a checkout session URL");
  }
  return { url: session.url, sessionId: session.id };
}
