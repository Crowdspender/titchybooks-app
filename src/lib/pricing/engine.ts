/**
 * Pricing engine — pure, side-effect-free math.
 *
 * All functions are parameterised by a ResolvedPricingConfig so the same
 * code runs:
 *   - on the server with the DB-backed config (authoritative), and
 *   - on the client mirror for instant UX with defaults or a fetched copy.
 *
 * All HUF amounts are integers; we round with Math.round unless otherwise
 * noted. Shipping is looked up (never computed), so no rounding is needed
 * there.
 *
 * Future-proofing (see plan Task 10): `calculateOrder` accepts an optional
 * `discount` input that produces a `discountHuf` line. When multi-shipment
 * support lands, a wrapper will iterate `OrderLine` entries and reuse
 * these primitives; the signatures here should not need to change.
 */

import {
  MAX_SHIPMENT_WEIGHT_GRAMS,
  PRICE_BREAK_QUANTITIES,
  type PriceTier,
  type ResolvedPricingConfig,
  type Zone,
} from "./constants";

export interface CalculatedOrder {
  quantity: number;
  zone: Zone;
  weightGrams: number;
  /** Index into cfg.weightBands; -1 means over max. */
  shippingBand: number;
  unitPriceHuf: number;
  printCostHuf: number;
  handlingCostHuf: number;
  shippingCostHuf: number;
  vaultFeeHuf: number;
  discountHuf: number;
  totalHuf: number;
  /** (printCost + handling + shipping + vault - discount) / quantity, rounded. */
  costPerBookHuf: number;
  currency: "HUF";
}

export interface DiscountInput {
  /** Fixed amount to subtract from the total, in HUF. */
  fixedHuf?: number;
  /** Percent (0-100) applied to printCost. */
  percent?: number;
  /** Optional human-readable label used purely for logging. */
  label?: string;
}

export interface CalculateOrderOptions {
  discount?: DiscountInput;
  vaultAddOn?: boolean;
}

export function calculateWeight(
  quantity: number,
  cfg: ResolvedPricingConfig
): number {
  return quantity * cfg.weightPerBookGrams;
}

/**
 * Returns the band index for a given weight, or -1 if the weight exceeds
 * the last band. Bands are upper-inclusive.
 */
export function getWeightBand(
  weight: number,
  cfg: ResolvedPricingConfig
): number {
  if (weight <= 0) return -1;
  const idx = cfg.weightBands.findIndex((cap) => weight <= cap);
  return idx;
}

export function getShippingCost(
  zone: Zone,
  quantity: number,
  cfg: ResolvedPricingConfig
): number {
  const row = cfg.shippingTable[zone];
  if (!row) {
    throw new Error(`Zone "${zone}" is not configured`);
  }
  const weight = calculateWeight(quantity, cfg);
  const band = getWeightBand(weight, cfg);
  if (band === -1) {
    throw new Error(
      `Shipment weight ${weight}g exceeds the ${MAX_SHIPMENT_WEIGHT_GRAMS}g limit`
    );
  }
  return row[band];
}

export function findTier(
  quantity: number,
  tiers: readonly PriceTier[]
): PriceTier | null {
  return (
    tiers.find((tier) => quantity >= tier.min && quantity <= tier.max) ?? null
  );
}

export function getUnitPrice(
  quantity: number,
  cfg: ResolvedPricingConfig
): number {
  const tier = findTier(quantity, cfg.priceTiers);
  if (!tier) {
    throw new Error(`No pricing tier covers quantity ${quantity}`);
  }
  return tier.pricePerCopy;
}

export function getHandlingCost(
  printCost: number,
  cfg: ResolvedPricingConfig
): number {
  const pct = (printCost * cfg.handlingPercent) / 100;
  return cfg.handlingFixedHuf + Math.ceil(pct);
}

function applyDiscount(
  printCost: number,
  discount: DiscountInput | undefined
): number {
  if (!discount) return 0;
  const fixed = discount.fixedHuf ?? 0;
  const pct =
    discount.percent && discount.percent > 0
      ? Math.floor((printCost * discount.percent) / 100)
      : 0;
  return Math.max(0, fixed + pct);
}

export function calculateOrder(
  zone: Zone,
  quantity: number,
  cfg: ResolvedPricingConfig,
  options: CalculateOrderOptions = {}
): CalculatedOrder {
  const weightGrams = calculateWeight(quantity, cfg);
  const shippingBand = getWeightBand(weightGrams, cfg);
  if (shippingBand === -1) {
    throw new Error(
      `Shipment weight ${weightGrams}g exceeds the ${MAX_SHIPMENT_WEIGHT_GRAMS}g limit`
    );
  }

  const unitPriceHuf = getUnitPrice(quantity, cfg);
  const printCostHuf = unitPriceHuf * quantity;
  const handlingCostHuf = getHandlingCost(printCostHuf, cfg);
  const shippingCostHuf = getShippingCost(zone, quantity, cfg);
  const vaultFeeHuf = options.vaultAddOn ? cfg.vaultFeeHuf : 0;
  const discountHuf = applyDiscount(printCostHuf, options.discount);
  const totalHuf = Math.max(
    0,
    printCostHuf + handlingCostHuf + shippingCostHuf + vaultFeeHuf - discountHuf
  );
  const costPerBookHuf = Math.round(totalHuf / quantity);

  return {
    quantity,
    zone,
    weightGrams,
    shippingBand,
    unitPriceHuf,
    printCostHuf,
    handlingCostHuf,
    shippingCostHuf,
    vaultFeeHuf,
    discountHuf,
    totalHuf,
    costPerBookHuf,
    currency: "HUF",
  };
}

/**
 * Maximum quantity that still fits every band. Used to snap upwards to the
 * next "cheap shipping" sweet spot.
 */
export function bandCeilingQuantity(
  bandIndex: number,
  cfg: ResolvedPricingConfig
): number {
  const weightCap = cfg.weightBands[bandIndex];
  if (!weightCap) return 0;
  return Math.floor(weightCap / cfg.weightPerBookGrams);
}

export interface OptimalSuggestion {
  suggestedQuantity: number;
  savingsPct: number;
  currentCostPerBook: number;
  suggestedCostPerBook: number;
}

/**
 * Look at nearby band ceilings and tier minimums and return the quantity
 * that delivers the lowest cost-per-book. Returns null when the current
 * quantity is already optimal (or strictly better than any alternative).
 */
export function suggestOptimalQuantity(
  zone: Zone,
  quantity: number,
  cfg: ResolvedPricingConfig
): OptimalSuggestion | null {
  let current: CalculatedOrder;
  try {
    current = calculateOrder(zone, quantity, cfg);
  } catch {
    return null;
  }

  // Build a list of candidate quantities: each band ceiling plus each
  // tier minimum. Skip candidates that exceed the weight limit or are
  // smaller than the current quantity — suggesting a smaller order is
  // unhelpful because the user explicitly wants at least `quantity`.
  const candidates = new Set<number>();
  for (let band = 0; band < cfg.weightBands.length; band += 1) {
    const q = bandCeilingQuantity(band, cfg);
    if (q > quantity) candidates.add(q);
  }
  for (const tier of cfg.priceTiers) {
    if (tier.min > quantity) candidates.add(tier.min);
  }

  let best: CalculatedOrder | null = null;
  for (const q of candidates) {
    if (q === quantity) continue;
    try {
      const candidate = calculateOrder(zone, q, cfg);
      if (
        candidate.costPerBookHuf < (best?.costPerBookHuf ?? Infinity) &&
        candidate.costPerBookHuf < current.costPerBookHuf
      ) {
        best = candidate;
      }
    } catch {
      // candidate exceeds the weight cap; skip
    }
  }

  if (!best) return null;

  const savingsPct =
    ((current.costPerBookHuf - best.costPerBookHuf) /
      current.costPerBookHuf) *
    100;

  return {
    suggestedQuantity: best.quantity,
    savingsPct: Math.round(savingsPct * 10) / 10,
    currentCostPerBook: current.costPerBookHuf,
    suggestedCostPerBook: best.costPerBookHuf,
  };
}

export interface UxMessage {
  level: "info" | "tip" | "warning";
  text: string;
}

/** Distance (in copies) from `quantity` that still counts as "near" a break. */
const NEAR_BREAK_WINDOW = 5;

export function buildUxMessages(
  zone: Zone,
  quantity: number,
  cfg: ResolvedPricingConfig
): UxMessage[] {
  const messages: UxMessage[] = [];

  let current: CalculatedOrder;
  try {
    current = calculateOrder(zone, quantity, cfg);
  } catch (error) {
    messages.push({
      level: "warning",
      text:
        error instanceof Error
          ? error.message
          : "Order cannot be calculated",
    });
    return messages;
  }

  // Highlight canonical sweet spots from the product spec.
  if (PRICE_BREAK_QUANTITIES.includes(quantity)) {
    messages.push({
      level: "tip",
      text: `You hit a sweet spot: ${quantity} copies fit perfectly in a single shipping band.`,
    });
  }

  // Flag when within N copies of a cheaper-per-book band ceiling.
  for (const breakQty of PRICE_BREAK_QUANTITIES) {
    if (breakQty > quantity && breakQty - quantity <= NEAR_BREAK_WINDOW) {
      try {
        const better = calculateOrder(zone, breakQty, cfg);
        if (better.costPerBookHuf < current.costPerBookHuf) {
          messages.push({
            level: "info",
            text: `You are near the next price break at ${breakQty} copies — cost per book drops to ${better.costPerBookHuf} HUF.`,
          });
          break;
        }
      } catch {
        // skip
      }
    }
  }

  const suggestion = suggestOptimalQuantity(zone, quantity, cfg);
  if (suggestion && suggestion.savingsPct >= 5) {
    messages.push({
      level: "tip",
      text: `Best value: ordering ${suggestion.suggestedQuantity} copies reduces cost per book by ${suggestion.savingsPct}%.`,
    });
  }

  return messages;
}
