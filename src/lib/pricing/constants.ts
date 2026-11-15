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
  "canada",
  "australia_nz",
  "rest_of_world",
] as const;

export type Zone = (typeof ZONES)[number];

export const ZONE_LABELS: Record<Zone, string> = {
  hungary: "Hungary",
  eu: "European Union",
  uk: "United Kingdom",
  usa: "United States",
  canada: "Canada",
  australia_nz: "Australia & New Zealand",
  rest_of_world: "Rest of world",
};

export interface ShippingBand {
  /** Upper-inclusive weight cap in grams. */
  maxWeightGrams: number;
  /** Customer-facing price in HUF (postage plus handover allowance). */
  priceHuf: number;
}

/**
 * Measured weight of one booklet. Every bandwidth below is expressed in grams,
 * so a 31.5 kg carrier ceiling is 31500.
 */
export const DEFAULT_WEIGHT_PER_BOOK_GRAMS = 6;

/** Letter / large-letter caps shared by every zone. */
const LETTER_BAND_CAPS = [50, 100, 250, 500, 1000, 2000] as const;

function letterLadder(prices: readonly number[]): ShippingBand[] {
  return LETTER_BAND_CAPS.map((maxWeightGrams, index) => ({
    maxWeightGrams,
    priceHuf: prices[index] ?? 0,
  }));
}

function parcelBands(entries: readonly (readonly [number, number])[]): ShippingBand[] {
  return entries.map(([maxWeightGrams, priceHuf]) => ({
    maxWeightGrams,
    priceHuf,
  }));
}

/**
 * Default per-zone shipping ladders. Each zone matches one carrier product, so
 * the ladders differ: the heaviest band is that zone's hard weight limit and
 * orders above it are refused for a manual quote instead of being undercharged.
 *
 * `canada`, `australia_nz` and `rest_of_world` keep the previous provisional
 * small-parcel prices; their parcel tiers need country sheets before they can
 * accept heavy orders.
 */
export const DEFAULT_SHIPPING_TABLE: Record<Zone, readonly ShippingBand[]> = {
  // MPL Business domestic: letter bands, then published domestic parcels.
  hungary: [
    ...letterLadder([270, 305, 365, 540, 845, 1630]),
    ...parcelBands([
      [5000, 3460],
      [10000, 3770],
      [20000, 4610],
      [30000, 6930],
      [40000, 9660],
    ]),
  ],
  // MPL Europe Standard (nine covered countries), 31.5 kg ceiling. Retail
  // prices carry a modest handling allowance over published postage.
  eu: [
    ...letterLadder([1250, 1600, 2200, 3600, 6000, 10000]),
    ...parcelBands([
      [5000, 12500],
      [10000, 14900],
      [15000, 19000],
      [20000, 25500],
      [25000, 32500],
      [31500, 41000],
    ]),
  ],
  // Európa+ Zone 3 as the working basis for the UK, 30 kg ceiling.
  uk: [
    ...letterLadder([1300, 1650, 2300, 3700, 6200, 10200]),
    ...parcelBands([
      [5000, 24000],
      [10000, 34000],
      [15000, 48000],
      [20000, 63000],
      [25000, 79000],
      [30000, 94000],
    ]),
  ],
  // International postal parcel up to 10 kg; EMS or a courier quotes above.
  usa: [
    ...letterLadder([1550, 2000, 3000, 5000, 8500, 14000]),
    ...parcelBands([
      [5000, 35000],
      [10000, 49000],
    ]),
  ],
  canada: [...letterLadder([1550, 2000, 3000, 5000, 8500, 14000])],
  australia_nz: [...letterLadder([1550, 2000, 3000, 5000, 8500, 14000])],
  rest_of_world: [...letterLadder([1550, 2000, 3000, 5000, 8500, 14000])],
};

export interface PriceTier {
  min: number;
  max: number;
  pricePerCopy: number;
}

/** JSON-safe upper bound representing an open-ended quantity tier. */
export const OPEN_ENDED_TIER_MAX = Number.MAX_SAFE_INTEGER;

/** Default volume discount ladder in HUF per copy. */
export const DEFAULT_PRICE_TIERS: readonly PriceTier[] = [
  { min: 1, max: 7, pricePerCopy: 300 },
  { min: 8, max: 40, pricePerCopy: 250 },
  { min: 41, max: 80, pricePerCopy: 220 },
  { min: 81, max: 160, pricePerCopy: 190 },
  { min: 161, max: 333, pricePerCopy: 170 },
  { min: 334, max: OPEN_ENDED_TIER_MAX, pricePerCopy: 150 },
];

/** Heaviest band across the default ladders (domestic 40 kg parcels). */
export const MAX_SHIPMENT_WEIGHT_GRAMS = 40000;

/** Largest order quantity that fits the heaviest band at the default weight. */
export const MAX_ORDER_QUANTITY = Math.floor(
  MAX_SHIPMENT_WEIGHT_GRAMS / DEFAULT_WEIGHT_PER_BOOK_GRAMS
);

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
 * Quantities that hit a band ceiling or tier boundary. Used for smart UX hints
 * and the quick-pick chips in the order panel; the panel hides the chips that
 * exceed the selected zone's weight limit.
 */
export const PRICE_BREAK_QUANTITIES: readonly number[] = [
  8, 40, 80, 160, 333, 833, 1666, 3333, 5000, 6666,
];

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
  shippingTable: Record<Zone, ShippingBand[]>;
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
