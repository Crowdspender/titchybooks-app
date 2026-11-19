import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ResolvedPricingConfig } from "./constants";
import { calculateCharge } from "./charge";
import { calculateOrder, calculateWeight } from "./engine";
import { assertDestinationWeight, ManualQuoteRequired, resolveDestination, type ShippingPolicy } from "./destination";
import { calculateOrderInputSchema, type QuoteInputs } from "./schema";

export const OFFER_TTL_MS = 10 * 60_000;

/** Stable serialization for signature/input identity; excludes absent optional values. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function signingKey() {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Online offers are not configured");
  return createHmac("sha256", secret).update("titchybooks:print-preview:v1").digest();
}

export function buildOffer(
  userId: string, input: QuoteInputs, cfg: ResolvedPricingConfig,
  policy: ShippingPolicy | null, now = Date.now(),
) {
  const inputs = calculateOrderInputSchema.parse(input);
  if (!policy) throw new ManualQuoteRequired();
  const destination = resolveDestination(inputs.shippingAddress.countryCode, inputs.shippingAddress.postalCode,
    inputs.vaultAddOn, cfg, policy, inputs.zone);
  assertDestinationWeight(destination, calculateWeight(inputs.quantity, cfg, destination));
  const calculation = calculateOrder(destination.zone, inputs.quantity, cfg, { ...destination, vaultAddOn: inputs.vaultAddOn });
  if (Object.values(calculation).some(value => typeof value === "number" && (!Number.isSafeInteger(value) || value < 0 || value > 2147483647))) {
    throw new ManualQuoteRequired("Order amount needs a manual review. Please contact us for a quote.");
  }
  const charge = calculateCharge(calculation.totalHuf, inputs.currency, cfg.currencyRates);
  return {
    version: 1 as const, purpose: "print-order-preview" as const,
    userId, inputs, inputDigest: digest(inputs), issuedAt: now, expiresAt: now + OFFER_TTL_MS,
    calculation, charge, pricingConfig: cfg,
    shipping: { destination, policyDigest: digest(policy), approvalReference: policy.approvalReference,
      approvedAt: policy.approvedAt, weightRule: policy.weightRule },
    terms: policy.terms,
  };
}
export type PreviewOffer = ReturnType<typeof buildOffer>;

export function signOffer(offer: PreviewOffer): string {
  const encoded = Buffer.from(canonicalJson(offer)).toString("base64url");
  if (encoded.length > 79000) throw new Error("Offer configuration is too large");
  return `${encoded}.${createHmac("sha256", signingKey()).update(encoded).digest("base64url")}`;
}

export class OfferReviewRequired extends Error {
  readonly code = "OFFER_REVIEW_REQUIRED";
  constructor() { super("This offer is expired or no longer matches. Review a fresh quote before ordering."); }
}

export function verifyOffer(token: string, userId: string, input: QuoteInputs, now = Date.now()): PreviewOffer {
  try {
    if (token.length > 80000) throw new Error();
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", signingKey()).update(encoded).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const offer = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PreviewOffer;
    if (offer.version !== 1 || offer.purpose !== "print-order-preview" || offer.userId !== userId ||
        !Number.isSafeInteger(offer.issuedAt) || offer.issuedAt > now ||
        offer.expiresAt !== offer.issuedAt + OFFER_TTL_MS || offer.expiresAt <= now ||
        offer.inputDigest !== digest(calculateOrderInputSchema.parse(input)) || offer.inputDigest !== digest(offer.inputs)) throw new Error();
    return offer;
  } catch { throw new OfferReviewRequired(); }
}

/** New acceptance may be stopped by a changed/disabled policy; accepted orders never expire. */
export function assertOfferPolicy(offer: PreviewOffer, policy: ShippingPolicy | null) {
  if (!policy) throw new ManualQuoteRequired();
  if (offer.shipping.policyDigest !== digest(policy)) throw new OfferReviewRequired();
  const destination = resolveDestination(offer.inputs.shippingAddress.countryCode, offer.inputs.shippingAddress.postalCode,
    offer.inputs.vaultAddOn, offer.pricingConfig, policy, offer.inputs.zone);
  assertDestinationWeight(destination, offer.calculation.weightGrams);
}
