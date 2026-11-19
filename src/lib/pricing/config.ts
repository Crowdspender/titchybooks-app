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
  DEFAULT_WEIGHT_PER_BOOK_GRAMS,
  ZONES,
  type PriceTier,
  type ResolvedPricingConfig,
  type ShippingBand,
  type Zone,
} from "./constants";
import {
  cloneShippingTable,
  configuredWeightCaps,
  normaliseShippingTable,
  strictShippingTable,
} from "./shipping";
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
  weightBands?: string | null;
  shippingTable: string;
  priceTiers: string;
  currencyRates?: string | null;
  vaultFeeHuf?: number | null;
}): ResolvedPricingConfig {
  const enabledZones = parseJsonField<Zone[]>(row.enabledZones, [...ZONES]);
  const rawShippingTable = parseJsonField<unknown>(row.shippingTable, null);
  const shippingTable = rawShippingTable
    ? normaliseShippingTable(
        rawShippingTable,
        parseJsonField<unknown>(row.weightBands ?? "", null)
      )
    : cloneShippingTable(DEFAULT_RESOLVED_CONFIG.shippingTable);
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
    // The per-zone ladders are authoritative. The legacy shared-band column
    // keeps the union of configured ceilings so older readers stay sane.
    weightBands: JSON.stringify(configuredWeightCaps(cfg.shippingTable)),
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

  const value = row
    ? resolveRow(row)
    : {
        ...DEFAULT_RESOLVED_CONFIG,
        shippingTable: cloneShippingTable(DEFAULT_RESOLVED_CONFIG.shippingTable),
      };
  cache = { value, loadedAt: Date.now() };
  return value;
}

/** Uncached, fail-closed reader for new commercial offers; never substitutes defaults. */
export async function loadCheckoutPricingConfig(): Promise<ResolvedPricingConfig> {
  const row = await prisma.pricingConfig.findUnique({ where: { id: PRICING_CONFIG_ID } });
  if (!row || !Number.isSafeInteger(row.version) || row.version < 1) throw new Error("Pricing needs review before online ordering");
  try {
    // Malformed shared bands must only condemn legacy ladders: canonical
    // per-zone rows carry their own ceilings and never read weightBands.
    let sharedBands: unknown = null;
    try { sharedBands = JSON.parse(row.weightBands); } catch { /* keep null so legacy rows fail below */ }
    const shippingTable = strictShippingTable(JSON.parse(row.shippingTable), sharedBands);
    const input = pricingConfigInputSchema.parse({
      weightPerBookGrams: row.weightPerBookGrams,
      handlingFixedHuf: row.handlingFixedHuf,
      handlingPercent: row.handlingPercent,
      enabledZones: JSON.parse(row.enabledZones), shippingTable,
      priceTiers: JSON.parse(row.priceTiers), currencyRates: JSON.parse(row.currencyRates),
      vaultFeeHuf: row.vaultFeeHuf,
    });
    return { ...input, version: row.version };
  } catch {
    throw new Error("Pricing needs review before online ordering");
  }
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
    shippingTable: Object.fromEntries(
      ZONES.map((zone) => [
        zone,
        DEFAULT_SHIPPING_TABLE[zone].map((band) => ({ ...band })),
      ])
    ) as Record<Zone, ShippingBand[]>,
    priceTiers: DEFAULT_PRICE_TIERS.map((tier) => ({ ...tier })),
    currencyRates: { ...DEFAULT_CURRENCY_RATES },
    vaultFeeHuf: DEFAULT_VAULT_FEE_HUF,
  };
}
