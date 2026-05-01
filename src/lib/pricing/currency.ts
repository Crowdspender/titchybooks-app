/**
 * Currency support for display and order capture.
 *
 * The pricing engine calculates every amount in HUF (the DB column
 * `*Huf` values are authoritative). For UI display and for recording
 * the user's preferred currency on the Order, we convert from HUF
 * using fixed reference rates. These rates are intentionally coarse
 * and updated via code review; the engine remains the source of
 * truth for the underlying HUF numbers.
 */

export const SUPPORTED_CURRENCIES = ["HUF", "EUR", "GBP"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY: Currency = "EUR";

export const CURRENCY_LABELS: Record<Currency, string> = {
  HUF: "Hungarian Forint (HUF)",
  EUR: "Euro (EUR)",
  GBP: "British Pound (GBP)",
};

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  HUF: "Ft",
  EUR: "€",
  GBP: "£",
};

/**
 * How many units of the target currency equal 1 HUF.
 * Example: 1 HUF ≈ 0.0026 EUR.
 * Keep these conservative; update when markets move materially.
 *
 * NOTE: This object is the *fallback* used when the caller doesn't pass
 * explicit rates. The authoritative rates live on the PricingConfig DB
 * row and flow through `ResolvedPricingConfig.currencyRates`.
 */
export const HUF_TO_CURRENCY_RATE: Record<Currency, number> = {
  HUF: 1,
  EUR: 0.0026,
  GBP: 0.0022,
};

/** Map of HUF→target-currency factors. HUF must always map to 1. */
export type CurrencyRates = Record<Currency, number>;

/** Return a safe rates object, filling any gaps from the fallback. */
export function resolveRates(
  rates?: Partial<CurrencyRates> | null,
): CurrencyRates {
  return {
    HUF: 1,
    EUR: rates?.EUR ?? HUF_TO_CURRENCY_RATE.EUR,
    GBP: rates?.GBP ?? HUF_TO_CURRENCY_RATE.GBP,
  };
}

/** Convert a HUF amount to the target currency. */
export function convertFromHuf(
  amountHuf: number,
  currency: Currency,
  rates?: Partial<CurrencyRates> | null,
): number {
  if (currency === "HUF") return Math.round(amountHuf);
  const resolved = resolveRates(rates);
  return amountHuf * resolved[currency];
}

/**
 * Format a HUF amount as the target currency using locale-appropriate
 * conventions. HUF is integer-only; EUR and GBP use two decimals.
 */
export function formatMoney(
  amountHuf: number,
  currency: Currency,
  rates?: Partial<CurrencyRates> | null,
): string {
  const value = convertFromHuf(amountHuf, currency, rates);
  if (currency === "HUF") {
    return `${Math.round(value).toLocaleString("en-US")} Ft`;
  }
  const locale = currency === "EUR" ? "de-DE" : "en-GB";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function isCurrency(value: unknown): value is Currency {
  return (
    typeof value === "string" &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value)
  );
}
