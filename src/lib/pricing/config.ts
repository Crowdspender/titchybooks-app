/**
 * PricingConfig loader / writer. Caches the resolved config in-memory so
 * hot calls to `/api/orders/calculate` don't re-hit SQLite on every keystroke.
 * The cache is invalidated whenever an admin saves new values.
 */

import { prisma } from "@/lib/prisma";
import {
  DEFAULT_CURRENCY_RATES,
  DEFAULT_PRICE_TIERS,
  DEFAULT_RESOLVED_CONFIG,
  DEFAULT_SHIPPING_TABLE,
  DEFAULT_VAULT_FEE_HUF,
  DEFAULT_WEIGHT_BANDS,
  DEFAULT_WEIGHT_PER_BOOK_GRAMS,
  ZONES,
  type PriceTier,
  type ResolvedPricingConfig,
  type Zone,
} from "./constants";
import {
  pricingConfigInputSchema,
  type PricingConfigInput,
} from "./schema";

const PRICING_CONFIG_ID = "default";

let cache: { value: ResolvedPricingConfig; loadedAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

function parseJsonField<T>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value);
    return parsed as T;
  } catch {
    return fallback;
  }
}

function resolveRow(row: {
  version: number;
  weightPerBookGrams: number;
  handlingFixedHuf: number;
  handlingPercent: number;
  enabledZones: string;
  weightBands: string;
  shippingTable: string;
  priceTiers: string;
  currencyRates?: string | null;
  vaultFeeHuf?: number | null;
}): ResolvedPricingConfig {
  const enabledZones = parseJsonField<Zone[]>(row.enabledZones, [...ZONES]);
  const weightBands = parseJsonField<number[]>(row.weightBands, [
    ...DEFAULT_WEIGHT_BANDS,
  ]);
  const shippingTable = parseJsonField<Record<Zone, number[]>>(
    row.shippingTable,
    Object.fromEntries(
      ZONES.map((zone) => [zone, [...DEFAULT_SHIPPING_TABLE[zone]]])
    ) as Record<Zone, number[]>
  );
  const priceTiers = parseJsonField<PriceTier[]>(
    row.priceTiers,
    DEFAULT_PRICE_TIERS.map((tier) => ({ ...tier }))
  );
  const currencyRates = parseJsonField<{ HUF: number; EUR: number; GBP: number }>(
    row.currencyRates ?? "",
    { ...DEFAULT_CURRENCY_RATES }
  );
  // HUF is the base currency — force to 1 to prevent drift.
  currencyRates.HUF = 1;

  return {
    version: row.version,
    weightPerBookGrams: row.weightPerBookGrams,
    handlingFixedHuf: row.handlingFixedHuf,
    handlingPercent: row.handlingPercent,
    enabledZones,
    weightBands,
    shippingTable,
    priceTiers,
    currencyRates,
    vaultFeeHuf: row.vaultFeeHuf ?? DEFAULT_VAULT_FEE_HUF,
  };
}

function serialiseForDb(cfg: PricingConfigInput) {
  return {
    weightPerBookGrams: cfg.weightPerBookGrams,
    handlingFixedHuf: cfg.handlingFixedHuf,
    handlingPercent: cfg.handlingPercent,
    enabledZones: JSON.stringify(cfg.enabledZones),
    weightBands: JSON.stringify(cfg.weightBands),
    shippingTable: JSON.stringify(cfg.shippingTable),
    priceTiers: JSON.stringify(cfg.priceTiers),
    currencyRates: JSON.stringify({ ...cfg.currencyRates, HUF: 1 }),
    vaultFeeHuf: cfg.vaultFeeHuf,
  };
}

export function invalidatePricingConfigCache() {
  cache = null;
}

export async function loadPricingConfig(): Promise<ResolvedPricingConfig> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  const row = await prisma.pricingConfig.findUnique({
    where: { id: PRICING_CONFIG_ID },
  });

  const value = row ? resolveRow(row) : { ...DEFAULT_RESOLVED_CONFIG };
  cache = { value, loadedAt: Date.now() };
  return value;
}

export async function savePricingConfig(
  input: PricingConfigInput,
  adminUserId: string
): Promise<ResolvedPricingConfig> {
  const parsed = pricingConfigInputSchema.parse(input);
  const serialised = serialiseForDb(parsed);

  const existing = await prisma.pricingConfig.findUnique({
    where: { id: PRICING_CONFIG_ID },
  });

  const saved = await prisma.pricingConfig.upsert({
    where: { id: PRICING_CONFIG_ID },
    create: {
      id: PRICING_CONFIG_ID,
      version: 1,
      ...serialised,
      updatedByUserId: adminUserId,
    },
    update: {
      ...serialised,
      version: (existing?.version ?? 0) + 1,
      updatedByUserId: adminUserId,
    },
  });

  invalidatePricingConfigCache();
  return resolveRow(saved);
}

/** Defaults used by the seed script. */
export function defaultPricingConfigInput(): PricingConfigInput {
  return {
    weightPerBookGrams: DEFAULT_WEIGHT_PER_BOOK_GRAMS,
    handlingFixedHuf: 0,
    handlingPercent: 0,
    enabledZones: [...ZONES],
    weightBands: [...DEFAULT_WEIGHT_BANDS],
    shippingTable: Object.fromEntries(
      ZONES.map((zone) => [zone, [...DEFAULT_SHIPPING_TABLE[zone]]])
    ) as Record<Zone, number[]>,
    priceTiers: DEFAULT_PRICE_TIERS.map((tier) => ({ ...tier })),
    currencyRates: { ...DEFAULT_CURRENCY_RATES },
    vaultFeeHuf: DEFAULT_VAULT_FEE_HUF,
  };
}
