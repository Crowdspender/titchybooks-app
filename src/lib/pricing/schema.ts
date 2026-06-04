import { z } from "zod";
import { ORDER_STATUSES, ZONES } from "./constants";
import { SUPPORTED_CURRENCIES } from "./currency";

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
    weightBands: z
      .array(z.number().int().min(1))
      .length(6, "Six weight bands required"),
    shippingTable: z.record(zoneEnum, z.array(z.number().int().min(0)).length(6)),
    priceTiers: z.array(priceTierSchema).min(1),
    currencyRates: currencyRatesSchema,
    vaultFeeHuf: z.number().int().min(0).default(2000),
  })
  .refine(
    (cfg) =>
      // Every enabled zone must have a row in the shipping table.
      cfg.enabledZones.every((zone) => Array.isArray(cfg.shippingTable[zone])),
    { message: "Every enabled zone needs a shipping price row" }
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

export const calculateOrderInputSchema = z.object({
  submissionId: z.string().min(1).optional(),
  zone: zoneEnum,
  quantity: z.number().int().min(1).max(333),
  currency: currencyEnum.optional(),
  vaultAddOn: z.boolean().optional(),
});

export const shippingAddressSchema = z.object({
  recipientName: z.string().trim().min(1).max(120),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().min(1).max(20),
  countryCode: z.string().trim().length(2).toUpperCase(),
  phone: z.string().trim().max(40).optional(),
});

export type ShippingAddressInput = z.infer<typeof shippingAddressSchema>;

export const createOrderInputSchema = z.object({
  submissionId: z.string().min(1),
  zone: zoneEnum,
  quantity: z.number().int().min(1).max(333),
  currency: currencyEnum.optional(),
  shippingAddress: shippingAddressSchema,
  vaultAddOn: z.boolean().optional(),
});

export const adminUpdateOrderSchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const adminListOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
