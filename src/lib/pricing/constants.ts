/**
 * Titchybooks pricing engine — default values and shared constants.
 *
 * These mirror the Magyar Posta weight bands and the default tier ladder
 * from the product spec. The actual values used at runtime always come
 * from the PricingConfig DB row (see config.ts); these defaults exist so
 * the engine can run without a DB (tests, client preview) and so the
 * seed script has something to upsert.
 */

export const ZONES = [
  "hungary",
  "eu",
  "uk",
  "usa",
  "rest_of_world",
] as const;

export type Zone = (typeof ZONES)[number];

export const ZONE_LABELS: Record<Zone, string> = {
  hungary: "Hungary",
  eu: "European Union",
  uk: "United Kingdom",
  usa: "United States",
  rest_of_world: "Rest of world",
};

/** Upper-inclusive weight caps in grams. Index matches shippingTable column. */
export const DEFAULT_WEIGHT_BANDS: readonly number[] = [
  50, 100, 250, 500, 1000, 2000,
];

/** Default per-zone shipping cost in HUF, indexed by band. */
export const DEFAULT_SHIPPING_TABLE: Record<Zone, readonly number[]> = {
  hungary: [270, 305, 365, 540, 845, 1630],
  eu: [1250, 1600, 2200, 3600, 6000, 10000],
  uk: [1300, 1650, 2300, 3700, 6200, 10200],
  usa: [1550, 2000, 3000, 5000, 8500, 14000],
  rest_of_world: [1550, 2000, 3000, 5000, 8500, 14000],
};

export interface PriceTier {
  min: number;
  max: number;
  pricePerCopy: number;
}

/** Default volume discount ladder in HUF per copy. */
export const DEFAULT_PRICE_TIERS: readonly PriceTier[] = [
  { min: 1, max: 8, pricePerCopy: 300 },
  { min: 9, max: 40, pricePerCopy: 180 },
  { min: 41, max: 80, pricePerCopy: 120 },
  { min: 81, max: 160, pricePerCopy: 90 },
  { min: 161, max: 333, pricePerCopy: 70 },
];

export const DEFAULT_WEIGHT_PER_BOOK_GRAMS = 6;
export const MAX_SHIPMENT_WEIGHT_GRAMS = 2000;

/** Default flat fee (HUF) for the 2-copy vault storage add-on. */
export const DEFAULT_VAULT_FEE_HUF = 2000;

/** Admin-tunable order status lifecycle. */
export const ORDER_STATUSES = [
  "PENDING_PAYMENT",
  "PAID",
  "IN_PRODUCTION",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Allowed admin state transitions. Users can only move orders forward
 * along this graph (except CANCELLED which can be reached from most states).
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ["PAID", "CANCELLED"],
  PAID: ["IN_PRODUCTION", "CANCELLED"],
  IN_PRODUCTION: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: [],
};

/**
 * Quantities that hit exact band ceilings. Used for smart UX hints.
 * 8 books = 48g (fits 50g band), 40 = 240g (fits 250g), 80 = 480g (fits 500g).
 */
export const PRICE_BREAK_QUANTITIES: readonly number[] = [8, 40, 80];

/**
 * Default HUF→target-currency conversion factors. Admin-editable via the
 * pricing config admin page; these constants are only used as a bootstrap
 * fallback (tests / client mirror before the public pricing meta loads).
 */
export const DEFAULT_CURRENCY_RATES = {
  HUF: 1,
  EUR: 0.0026,
  GBP: 0.0022,
} as const;

/**
 * Normalised, fully-typed runtime pricing config (JSON strings unwrapped).
 */
export interface ResolvedPricingConfig {
  version: number;
  weightPerBookGrams: number;
  handlingFixedHuf: number;
  handlingPercent: number;
  enabledZones: Zone[];
  weightBands: number[];
  shippingTable: Record<Zone, number[]>;
  priceTiers: PriceTier[];
  currencyRates: { HUF: number; EUR: number; GBP: number };
  vaultFeeHuf: number;
}

/** In-memory defaults for tests / client mirror when no DB is available. */
export const DEFAULT_RESOLVED_CONFIG: ResolvedPricingConfig = {
  version: 0,
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
