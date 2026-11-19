import { Prisma } from "@prisma/client";
import type { Currency, CurrencyRates } from "./currency";

export const CHARGE_ROUNDING = "DECIMAL_HALF_UP_MINOR_2" as const;
const MINIMUM_AMOUNTS: Record<Currency, number> = { HUF: 17500, EUR: 50, GBP: 30 };

export function assertChargeAmount(amountMinor: number, currency: Currency) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < MINIMUM_AMOUNTS[currency] ||
      amountMinor > 99999999 || (currency === "HUF" && amountMinor % 100 !== 0)) {
    throw new Error(`Order total is outside the chargeable range in ${currency}`);
  }
}

/** Preserve the decimal representation actually used, never reconstruct FX on retry. */
export function calculateCharge(totalHuf: number, currency: Currency, rates: CurrencyRates) {
  if (!Number.isSafeInteger(totalHuf) || totalHuf < 0) throw new Error("Invalid HUF total");
  const fxRate = new Prisma.Decimal(String(rates[currency]));
  if (!fxRate.isFinite() || fxRate.lte(0) || fxRate.gt(10) || fxRate.decimalPlaces() > 18 ||
      (currency === "HUF" && !fxRate.eq(1))) throw new Error("Invalid charge rate");
  const amountMinor = new Prisma.Decimal(totalHuf).mul(fxRate).mul(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
  assertChargeAmount(amountMinor, currency);
  return { currency, amountMinor, fxRate: fxRate.toString(), rounding: CHARGE_ROUNDING };
}
