import { z } from "zod";
import { ZONES, type ResolvedPricingConfig, type Zone } from "./constants";

import { countryCodeSchema, normalizePostcode } from "./country";
const prefixSchema = z.string().trim().min(1).max(20)
  .transform(normalizePostcode).pipe(z.string().regex(/^[A-Z0-9]+$/));
const serviceSchema = z.object({
  countryCode: countryCodeSchema,
  zone: z.enum(ZONES),
  service: z.string().trim().min(1).max(120),
  maxWeightGrams: z.number().int().min(1).max(40000),
  allowedPostcodePrefixes: z.array(prefixSchema).min(1).max(100).optional(),
  excludedPostcodePrefixes: z.array(prefixSchema).max(100),
}).strict();

export const shippingPolicySchema = z.object({
  version: z.literal(1),
  enabled: z.literal(true),
  approvalReference: z.string().trim().min(1).max(500),
  approvedAt: z.string().datetime(),
  weightRule: z.object({
    packagingGrams: z.number().int().min(0).max(40000),
    // Copies retained at the Vault are not silently added to the customer parcel.
    vaultCopiesInCustomerParcel: z.number().int().min(0).max(2),
  }).strict(),
  terms: z.object({
    version: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(8000),
  }).strict(),
  services: z.array(serviceSchema).min(1).max(249),
}).strict().refine(policy => new Set(policy.services.map(s => s.countryCode)).size === policy.services.length,
  "Each country must resolve to exactly one approved service");
export type ShippingPolicy = z.infer<typeof shippingPolicySchema>;
export type ResolvedDestination = ShippingPolicy["services"][number] & {
  postalCode: string;
  packagingWeightGrams: number;
  shippedExtraCopies: number;
};

export class ManualQuoteRequired extends Error {
  readonly code = "MANUAL_QUOTE_REQUIRED";
  constructor(message = "Online shipping is unavailable. Please contact us for a manual quote.") {
    super(message);
  }
}

/** Server-only environment input; absent, invalid, or unapproved means disabled. */
export function loadShippingPolicy(): ShippingPolicy | null {
  const raw = process.env.ORDER_SHIPPING_POLICY_JSON;
  if (!raw || raw.length > 100000) return null;
  try {
    const parsed = shippingPolicySchema.safeParse(JSON.parse(raw));
    if (!parsed.success || Date.parse(parsed.data.approvedAt) > Date.now()) return null;
    return parsed.data;
  } catch { return null; }
}

export function resolveDestination(
  countryCode: string,
  postcode: string,
  vaultAddOn: boolean,
  cfg: ResolvedPricingConfig,
  policy: ShippingPolicy | null = loadShippingPolicy(),
  assertedZone?: Zone,
): ResolvedDestination {
  const country = countryCodeSchema.safeParse(countryCode);
  const postalCode = normalizePostcode(postcode);
  if (!country.success || !/^[A-Z0-9]{1,20}$/.test(postalCode) || !policy) throw new ManualQuoteRequired();
  const service = policy.services.find(s => s.countryCode === country.data);
  if (!service || !cfg.enabledZones.includes(service.zone) ||
      (assertedZone !== undefined && assertedZone !== service.zone) ||
      service.excludedPostcodePrefixes.some(prefix => postalCode.startsWith(prefix)) ||
      (service.allowedPostcodePrefixes && !service.allowedPostcodePrefixes.some(prefix => postalCode.startsWith(prefix)))) {
    throw new ManualQuoteRequired();
  }
  const ladder = cfg.shippingTable[service.zone];
  const tariffCap = ladder?.at(-1)?.maxWeightGrams ?? 0;
  if (!Number.isSafeInteger(tariffCap) || tariffCap <= 0) throw new ManualQuoteRequired();
  return {
    ...service, maxWeightGrams: Math.min(service.maxWeightGrams, tariffCap), postalCode,
    packagingWeightGrams: policy.weightRule.packagingGrams,
    shippedExtraCopies: vaultAddOn ? policy.weightRule.vaultCopiesInCustomerParcel : 0,
  };
}

export function assertDestinationWeight(destination: ResolvedDestination, weightGrams: number) {
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0 || weightGrams > destination.maxWeightGrams) {
    throw new ManualQuoteRequired("This shipment needs a manual quote. Please contact us before ordering.");
  }
}
