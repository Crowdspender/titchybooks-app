/**
 * Shipping-ladder parsing helpers.
 *
 * Pricing rows are stored as JSON strings. Older rows use a shared weight-band
 * matrix (`{ zone: [price, ...] }` plus a separate `weightBands` list); new rows
 * use a per-zone ladder (`{ zone: [{ maxWeightGrams, priceHuf }, ...] }`) so
 * each carrier product can keep its own weight steps and ceiling.
 *
 * This module is deliberately free of Prisma imports so the loader, the seed
 * script and the unit tests can all share it.
 */

import {
  ZONES,
  type ShippingBand,
  type Zone,
} from "./constants";

export function isShippingBand(value: unknown): value is ShippingBand {
  if (!value || typeof value !== "object") return false;
  const band = value as Partial<ShippingBand>;
  return (
    typeof band.maxWeightGrams === "number" &&
    band.maxWeightGrams > 0 &&
    typeof band.priceHuf === "number" &&
    band.priceHuf >= 0
  );
}

function normaliseLadder(
  row: unknown,
  legacyWeightBands: number[]
): ShippingBand[] {
  if (!Array.isArray(row)) return [];

  if (row.length > 0 && row.every(isShippingBand)) {
    return row
      .map((band) => ({
        maxWeightGrams: band.maxWeightGrams,
        priceHuf: band.priceHuf,
      }))
      .sort((a, b) => a.maxWeightGrams - b.maxWeightGrams);
  }

  // Legacy shape: one price per shared band index; `null` meant "no rate".
  return row.flatMap((price, index) => {
    const maxWeightGrams = legacyWeightBands[index];
    if (typeof price !== "number" || !maxWeightGrams) return [];
    return [{ maxWeightGrams, priceHuf: price }];
  });
}

/**
 * Returns a complete zone → ladder map, upgrading legacy matrix rows on the
 * fly so an un-migrated database keeps working after deploy.
 */
export function normaliseShippingTable(
  raw: unknown,
  legacyWeightBands: unknown
): Record<Zone, ShippingBand[]> {
  const source =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const legacyBands = Array.isArray(legacyWeightBands)
    ? legacyWeightBands.filter((value): value is number => typeof value === "number")
    : [];

  const table = {} as Record<Zone, ShippingBand[]>;
  for (const zone of ZONES) {
    table[zone] = normaliseLadder(source[zone], legacyBands);
  }
  return table;
}

/** Validate before adapting; checkout must not silently drop malformed prices. */
export function strictShippingTable(raw: unknown, legacyWeightBands: unknown): Record<Zone, ShippingBand[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid shipping configuration");
  const source = raw as Record<string, unknown>;
  if (Object.keys(source).some(key => !(ZONES as readonly string[]).includes(key))) throw new Error("Unknown shipping zone");
  const caps = Array.isArray(legacyWeightBands) ? legacyWeightBands : [];
  const validCaps = caps.length > 0 && caps.every((cap, i) => Number.isSafeInteger(cap) && cap > 0 && (i === 0 || cap > caps[i - 1]));
  for (const row of Object.values(source)) {
    if (!Array.isArray(row) || row.length > 64) throw new Error("Invalid shipping ladder");
    if (row.length === 0) continue;
    if (row.every(isShippingBand)) {
      if (!row.every((band, i) => Number.isSafeInteger(band.maxWeightGrams) && Number.isSafeInteger(band.priceHuf) &&
          (i === 0 || band.maxWeightGrams > row[i - 1].maxWeightGrams))) throw new Error("Invalid shipping bands");
    } else if (!validCaps || row.length !== caps.length ||
        !row.every(price => price === null || (Number.isSafeInteger(price) && price >= 0))) {
      throw new Error("Invalid legacy shipping prices");
    }
  }
  return normaliseShippingTable(raw, legacyWeightBands);
}

export function cloneShippingTable(
  table: Record<Zone, ShippingBand[]>
): Record<Zone, ShippingBand[]> {
  return Object.fromEntries(
    ZONES.map((zone) => [
      zone,
      (table[zone] ?? []).map((band) => ({ ...band })),
    ])
  ) as Record<Zone, ShippingBand[]>;
}

/**
 * Sorted union of every configured band ceiling. Written back to the legacy
 * `weightBands` column so older readers still see a sensible list.
 */
export function configuredWeightCaps(
  table: Record<Zone, ShippingBand[]>
): number[] {
  const caps = new Set<number>();
  for (const zone of ZONES) {
    for (const band of table[zone] ?? []) caps.add(band.maxWeightGrams);
  }
  return [...caps].sort((a, b) => a - b);
}
