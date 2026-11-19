import Stripe from "stripe";
import {
  convertFromHuf,
  type Currency,
  type CurrencyRates,
} from "./pricing/currency";
import { assertChargeAmount } from "./pricing/charge";

/**
 * Stripe Checkout integration. Cards never touch our servers: we create a
 * hosted Checkout session, redirect the buyer, and confirm payment via the
 * signed webhook at /api/stripe/webhook.
 */

let client: Stripe | null = null;
let clientKey: string | null = null;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function getStripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }
  if (!client || clientKey !== key) {
    client = new Stripe(key, { typescript: true });
    clientKey = key;
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
  amountMinor: number;
  currency: Currency;
  idempotencyKey: string;
  customerEmail?: string | null;
  attemptId?: string;
  providerRequest?: Stripe.Checkout.SessionCreateParams;
}

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

export class CheckoutSessionUnavailable extends Error {
  constructor(readonly sessionId: string) { super("Issued Checkout session needs review"); }
}

export function stripeLivemode(): boolean {
  const mode = /^(sk|rk)_(live|test)_/.exec(process.env.STRIPE_SECRET_KEY ?? "")?.[2];
  if (!mode) throw new Error("Provider account mode needs review");
  return mode === "live";
}

/** Own-account identity, fetched without any financial mutation. */
export async function retrieveStripeAccountContext() {
  const livemode = stripeLivemode();
  const account = await getStripeClient().accounts.retrieve(null);
  if (!account.id?.startsWith("acct_")) throw new Error("Provider account needs review");
  return { accountId: account.id, livemode };
}

/** Freeze this entire request before issuance, including redirects and email,
 * so changing application/configuration details cannot alter an ambiguous retry.
 */
export function buildCheckoutRequest(input: CheckoutSessionInput): Stripe.Checkout.SessionCreateParams {
  assertChargeAmount(input.amountMinor, input.currency);
  const appUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  const metadata = { orderId: input.orderId, ...(input.attemptId ? { attemptId: input.attemptId } : {}) };
  return {
    mode: "payment",
    client_reference_id: input.orderId,
    customer_email: input.customerEmail ?? undefined,
    metadata,
    payment_intent_data: { metadata },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.currency.toLowerCase(),
          unit_amount: input.amountMinor,
          product_data: {
            name: "TitchyBook printed book",
            description: input.submissionTitle,
          },
        },
      },
    ],
    success_url: `${appUrl}/dashboard/orders/${input.orderId}?checkout=success`,
    cancel_url: `${appUrl}/dashboard/orders/${input.orderId}?checkout=canceled`,
  };
}

export async function createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
  assertChargeAmount(input.amountMinor, input.currency);
  const session = await getStripeClient().checkout.sessions.create(
    input.providerRequest ?? buildCheckoutRequest(input), { idempotencyKey: input.idempotencyKey },
  );
  if (!session.id) throw new Error("Stripe did not return a checkout session ID");
  if (!session.url) throw new CheckoutSessionUnavailable(session.id);
  return { url: session.url, sessionId: session.id };
}

/** Canonical provider proof for legacy amounts/open-session recovery, never current FX. */
export async function retrieveOrderCheckoutSession(sessionId: string, orderId: string, currency: Currency) {
  const session = await getStripeClient().checkout.sessions.retrieve(sessionId);
  const keyMode = /^(sk|rk)_(live|test)_/.exec(process.env.STRIPE_SECRET_KEY ?? "")?.[2];
  if (!keyMode || session.id !== sessionId || session.mode !== "payment" || session.livemode !== (keyMode === "live") ||
      session.client_reference_id !== orderId || session.metadata?.orderId !== orderId ||
      session.currency !== currency.toLowerCase() || session.amount_total === null ||
      session.amount_subtotal !== session.amount_total || session.automatic_tax?.enabled ||
      session.total_details?.amount_discount !== 0 || session.total_details?.amount_tax !== 0 ||
      session.total_details?.amount_shipping !== 0) throw new Error("Provider session needs review");
  try { assertChargeAmount(session.amount_total, currency); }
  catch { throw new Error("Provider session needs review"); }
  return session;
}
