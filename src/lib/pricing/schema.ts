import { z } from "zod";
import { MAX_ORDER_QUANTITY, ORDER_STATUSES, ZONES } from "./constants";
import { DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "./currency";
import { countryCodeSchema, normalizePostcode } from "./country";

const zoneEnum = z.enum(ZONES);
const currencyEnum = z.enum(SUPPORTED_CURRENCIES);

export const priceTierSchema = z
  .object({
    min: z.number().int().min(1),
    max: z.number().int().min(1),
    pricePerCopy: z.number().int().min(0),
  })
  .refine((tier) => tier.max >= tier.min, {
    message: "Tier max must be >= min",
  });

/** One carrier weight step: everything up to `maxWeightGrams` costs `priceHuf`. */
export const shippingBandSchema = z.object({
  maxWeightGrams: z.number().int().min(1),
  priceHuf: z.number().int().min(0),
});

export const currencyRatesSchema = z
  .object({
    HUF: z.literal(1).default(1),
    EUR: z.number().positive().max(10),
    GBP: z.number().positive().max(10),
  })
  .strict();

export const pricingConfigInputSchema = z
  .object({
    weightPerBookGrams: z.number().int().min(1).max(1000),
    handlingFixedHuf: z.number().int().min(0),
    handlingPercent: z.number().min(0).max(100),
    enabledZones: z
      .array(zoneEnum)
      .min(1, "At least one zone must be enabled"),
    // Each zone keeps its own ladder: the last band is the carrier's ceiling.
    shippingTable: z.record(
      zoneEnum,
      z.array(shippingBandSchema).max(64)
    ),
    priceTiers: z.array(priceTierSchema).min(1),
    currencyRates: currencyRatesSchema,
    vaultFeeHuf: z.number().int().min(0).default(2000),
  })
  .refine(
    (cfg) =>
      // Every enabled zone must have rates, otherwise checkout would offer a
      // destination that can never be priced.
      cfg.enabledZones.every(
        (zone) => (cfg.shippingTable[zone]?.length ?? 0) > 0
      ),
    { message: "Every enabled zone needs at least one shipping band" }
  )
  .refine(
    (cfg) =>
      // Bands are matched in order, so each one must be heavier than the last.
      Object.values(cfg.shippingTable).every((ladder) =>
        ladder.every(
          (band, index) =>
            index === 0 ||
            band.maxWeightGrams > ladder[index - 1].maxWeightGrams
        )
      ),
    { message: "Shipping bands must increase in weight" }
  )
  .refine(
    (cfg) => {
      // Tier ladder must be sorted and cover [1..max] with no gaps / overlap.
      const tiers = [...cfg.priceTiers].sort((a, b) => a.min - b.min);
      if (tiers[0].min !== 1) return false;
      for (let i = 1; i < tiers.length; i += 1) {
        if (tiers[i].min !== tiers[i - 1].max + 1) return false;
      }
      return true;
    },
    { message: "Price tiers must be contiguous starting at quantity 1" }
  );

export type PricingConfigInput = z.infer<typeof pricingConfigInputSchema>;

export const shippingAddressSchema = z.object({
  recipientName: z.string().trim().min(1).max(120),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).default(""),
  city: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().min(1).max(20).transform(normalizePostcode)
    .pipe(z.string().regex(/^[A-Z0-9]{1,20}$/, "Enter a valid postal code")),
  countryCode: countryCodeSchema,
  phone: z.string().trim().max(40).default(""),
}).strict();

export type ShippingAddressInput = z.infer<typeof shippingAddressSchema>;

export const calculateOrderInputSchema = z.object({
  submissionId: z.string().min(1).max(120),
  // Compatibility assertion only: the destination resolver selects the tariff.
  zone: zoneEnum.optional(),
  quantity: z.number().int().min(1).max(MAX_ORDER_QUANTITY),
  currency: currencyEnum.default(DEFAULT_CURRENCY),
  shippingAddress: shippingAddressSchema,
  vaultAddOn: z.boolean().default(false),
}).strict();

export type QuoteInputs = z.infer<typeof calculateOrderInputSchema>;

export const createOrderInputSchema = calculateOrderInputSchema.extend({
  offerToken: z.string().min(1).max(80000),
  requestKey: z.string().uuid(),
  acceptTerms: z.literal(true, { message: "Accept the displayed charge and terms before ordering" }),
});

export const manualSettlementSchema = z.object({
  method: z.enum(["BANK_TRANSFER", "CASH", "OTHER"]),
  reference: z.string().trim().min(1, "Payment evidence is required").max(500),
  confirmed: z.literal(true, { message: "Confirm that you verified the manual payment" }),
}).strict();

export const adminUpdateOrderSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  expectedUpdatedAt: z.string().datetime().optional(),
  manualSettlement: manualSettlementSchema.optional(),
}).strict().superRefine((input, ctx) => {
  if (input.status === "PAID" && !input.manualSettlement) {
    ctx.addIssue({ code: "custom", path: ["manualSettlement"], message: "Manual settlement requires payment evidence and confirmation" });
  }
  if (input.manualSettlement && input.status !== "PAID") {
    ctx.addIssue({ code: "custom", path: ["manualSettlement"], message: "Payment evidence is only accepted when marking PAID" });
  }
  if (input.notes !== undefined && !input.expectedUpdatedAt) {
    ctx.addIssue({ code: "custom", path: ["expectedUpdatedAt"], message: "Reload the order before editing notes" });
  }
});

export type AdminUpdateOrderInput = z.infer<typeof adminUpdateOrderSchema>;

export const adminListOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
