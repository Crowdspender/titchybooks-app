import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RESOLVED_CONFIG, ZONES } from "@/lib/pricing/constants";
import { calculateOrder, calculateWeight, getShippingBand, bandCeilingQuantity, suggestOptimalQuantity, buildUxMessages } from "@/lib/pricing/engine";
import { calculateCharge } from "@/lib/pricing/charge";
import { assertDestinationWeight, loadShippingPolicy, resolveDestination, shippingPolicySchema } from "@/lib/pricing/destination";
import { countryCodeSchema } from "@/lib/pricing/country";
import { assertOfferPolicy, buildOffer, digest, OFFER_TTL_MS, signOffer, verifyOffer } from "@/lib/pricing/offer";
import { createOrderInputSchema } from "@/lib/pricing/schema";
import { strictShippingTable } from "@/lib/pricing/shipping";
import { SYNTHETIC_SHIPPING_POLICY as policy, syntheticQuoteInputs } from "../fixtures/pricing";

const cfg = DEFAULT_RESOLVED_CONFIG;
const now = Date.parse("2026-01-01T00:00:00.000Z");
afterEach(() => vi.unstubAllEnvs());

describe("disabled-by-default destination policy", () => {
  it.each(["", "{}", "not-json", JSON.stringify({ ...policy, enabled: false }), JSON.stringify({ ...policy, approvedAt: "2999-01-01T00:00:00.000Z" })])("fails closed for unapproved config %s", raw => {
    vi.stubEnv("ORDER_SHIPPING_POLICY_JSON", raw);
    expect(loadShippingPolicy()).toBeNull();
    expect(() => resolveDestination("HU", "1000", false, cfg)).toThrow(/manual quote/i);
  });
  it("only loads an explicit valid policy", () => {
    vi.stubEnv("ORDER_SHIPPING_POLICY_JSON", JSON.stringify(policy));
    expect(loadShippingPolicy()).toEqual(policy);
  });
  it.each(["00", "ZZ", "EU", "UK", "H", "HUU", "💰"]) ("rejects non-ISO country %s", country => {
    expect(countryCodeSchema.safeParse(country).success).toBe(false);
    expect(() => resolveDestination(country, "1000", false, cfg, policy)).toThrow();
  });
  it("normalizes country/postcode and rejects a zone override", () => {
    expect(resolveDestination(" hu ", " 10-00 ", false, cfg, policy)).toMatchObject({ zone: "hungary", postalCode: "1000" });
    expect(() => resolveDestination("DE", "10115", false, cfg, policy, "hungary")).toThrow(/manual quote/i);
  });
  it.each(["CA", "AU", "NZ", "FR", "GG", "JE", "IM", "PR"]) ("does not infer coverage for %s", country => {
    expect(() => resolveDestination(country, "1000", false, cfg, policy)).toThrow();
  });
  it.each(["bt1 1aa", "GY1-1AA", "JE2 3AA", "IM1 1AA"]) ("normalizes before excluding territory postcode %s", postcode => {
    expect(() => resolveDestination("GB", postcode, false, cfg, policy)).toThrow();
  });
  it("honors allowed prefixes and disabled zones", () => {
    const restricted = structuredClone(policy);
    restricted.services[0].allowedPostcodePrefixes = ["10"];
    expect(() => resolveDestination("HU", "2000", false, cfg, restricted)).toThrow();
    expect(() => resolveDestination("HU", "1000", false, { ...cfg, enabledZones: ["eu"] }, policy)).toThrow();
  });
  it.each(policy.services)("enforces $countryCode service cap at ±1 gram with explicit parcel extras", service => {
    const parcelPolicy = { ...policy, weightRule: { packagingGrams: 20, vaultCopiesInCustomerParcel: 2 } };
    const destination = resolveDestination(service.countryCode, "1000", true, cfg, parcelPolicy);
    for (const weight of [service.maxWeightGrams - 1, service.maxWeightGrams]) {
      expect(() => assertDestinationWeight(destination, weight)).not.toThrow();
    }
    expect(() => assertDestinationWeight(destination, service.maxWeightGrams + 1)).toThrow(/manual quote/i);
    const options = { packagingWeightGrams: destination.packagingWeightGrams, shippedExtraCopies: destination.shippedExtraCopies };
    const ceiling = Math.floor((service.maxWeightGrams - 20) / cfg.weightPerBookGrams) - 2;
    expect(calculateWeight(ceiling, cfg, options)).toBeLessThanOrEqual(service.maxWeightGrams);
    expect(calculateWeight(ceiling + 1, cfg, options)).toBeGreaterThan(service.maxWeightGrams);
  });
  it("rejects duplicate country services or omitted weight/terms approvals", () => {
    expect(shippingPolicySchema.safeParse({ ...policy, services: [...policy.services, policy.services[0]] }).success).toBe(false);
    expect(shippingPolicySchema.safeParse({ ...policy, weightRule: undefined }).success).toBe(false);
    expect(shippingPolicySchema.safeParse({ ...policy, terms: undefined }).success).toBe(false);
  });
  it("uses an independent approved service cap", () => {
    const limited = structuredClone(policy);
    limited.services[0].maxWeightGrams = 250;
    const destination = resolveDestination("HU", "1000", false, cfg, limited);
    expect(() => assertDestinationWeight(destination, 250)).not.toThrow();
    expect(() => assertDestinationWeight(destination, 251)).toThrow(/manual quote/i);
    expect(() => buildOffer("owner", syntheticQuoteInputs(), cfg, limited, now)).toThrow();
  });
});

describe("packaging and Vault-copy weight without changing tariffs", () => {
  it("keeps the existing zero-extra default and applies only explicit policy weight", () => {
    expect(calculateWeight(40, cfg)).toBe(240);
    expect(buildOffer("owner", syntheticQuoteInputs(), cfg, policy, now).calculation.weightGrams).toBe(260);
    const withVault = { ...syntheticQuoteInputs(), vaultAddOn: true };
    expect(buildOffer("owner", withVault, cfg, policy, now).calculation.weightGrams).toBe(260);
    const parcelCopies = { ...policy, weightRule: { packagingGrams: 20, vaultCopiesInCustomerParcel: 2 } };
    expect(buildOffer("owner", withVault, cfg, parcelCopies, now).calculation.weightGrams).toBe(272);
  });
  it.each(ZONES)("covers every default %s band at ±1 copy with packaging", zone => {
    const options = { packagingWeightGrams: 20, shippedExtraCopies: 2 };
    cfg.shippingTable[zone].forEach((band, index) => {
      const ceiling = bandCeilingQuantity(zone, index, cfg, options);
      for (const q of [ceiling - 1, ceiling, ceiling + 1].filter(q => q > 0)) {
        const weight = calculateWeight(q, cfg, options);
        const expected = cfg.shippingTable[zone].findIndex(b => weight <= b.maxWeightGrams);
        expect(getShippingBand(zone, weight, cfg)).toBe(expected);
        if (expected < 0) expect(() => calculateOrder(zone, q, cfg, options)).toThrow();
        else expect(calculateOrder(zone, q, cfg, options).shippingCostHuf).toBe(cfg.shippingTable[zone][expected].priceHuf);
      }
      expect(calculateWeight(ceiling, cfg, options)).toBeLessThanOrEqual(band.maxWeightGrams);
      expect(calculateWeight(ceiling + 1, cfg, options)).toBeGreaterThan(band.maxWeightGrams);
    });
    const suggestion = suggestOptimalQuantity(zone, 40, cfg, options);
    if (suggestion) expect(calculateOrder(zone, suggestion.suggestedQuantity, cfg, options).costPerBookHuf)
      .toBe(suggestion.suggestedCostPerBook);
  });
  it("restricts suggestions to actual service caps after packaging and Vault parcel copies", () => {
    const options = { packagingWeightGrams: 20, shippedExtraCopies: 2, maxWeightGrams: 500 };
    expect(bandCeilingQuantity("hungary", 10, cfg, options)).toBe(78);
    const suggestion = suggestOptimalQuantity("hungary", 40, cfg, options);
    expect(suggestion).not.toBeNull();
    expect(calculateWeight(suggestion!.suggestedQuantity, cfg, options)).toBeLessThanOrEqual(500);
  });
  it.each(ZONES)("checks every %s default carrier band and ceiling at ±1 gram", zone => {
    cfg.shippingTable[zone].forEach((band, index) => {
      expect(getShippingBand(zone, band.maxWeightGrams - 1, cfg)).toBe(index);
      expect(getShippingBand(zone, band.maxWeightGrams, cfg)).toBe(index);
      expect(getShippingBand(zone, band.maxWeightGrams + 1, cfg)).toBe(index + 1 < cfg.shippingTable[zone].length ? index + 1 : -1);
    });
  });
  it("covers every default print-tier boundary without rewriting tariffs", () => {
    cfg.priceTiers.forEach(tier => {
      for (const q of [tier.min - 1, tier.min, tier.min + 1].filter(q => q > 0 && q <= 6666)) {
        expect(calculateOrder("hungary", q, cfg).unitPriceHuf).toBe(cfg.priceTiers.find(t => q >= t.min && q <= t.max)?.pricePerCopy);
      }
    });
  });
});

describe("exact accepted currency charges", () => {
  it.each(["HUF", "EUR", "GBP"] as const)("captures original decimal FX for %s", currency => {
    const charge = calculateCharge(4000, currency, cfg.currencyRates);
    expect(charge.amountMinor).toBe({ HUF: 400000, EUR: 1040, GBP: 880 }[currency]);
    expect(charge.fxRate).toBe(String(cfg.currencyRates[currency]));
    expect(charge.rounding).toBe("DECIMAL_HALF_UP_MINOR_2");
  });
  it("uses decimal half-up at an exact half-cent, not binary floating point", () => {
    expect(calculateCharge(1000, "EUR", { HUF: 1, EUR: 0.000575, GBP: 0.002 }).amountMinor).toBe(58);
  });
  it.each([
    [175, "HUF", 1, 17500], [500, "EUR", 0.001, 50], [300, "GBP", 0.001, 30],
  ] as const)("accepts the %s %s minimum", (total, currency, rate, expected) => {
    expect(calculateCharge(total, currency, { HUF: 1, EUR: rate, GBP: rate }).amountMinor).toBe(expected);
  });
  it("rejects below-minimum/invalid/unsafe rates and amounts", () => {
    expect(() => calculateCharge(174, "HUF", cfg.currencyRates)).toThrow();
    expect(() => calculateCharge(100, "EUR", cfg.currencyRates)).toThrow();
    expect(() => calculateCharge(100, "GBP", cfg.currencyRates)).toThrow();
    expect(() => calculateCharge(1000, "EUR", { ...cfg.currencyRates, EUR: NaN })).toThrow();
    expect(() => calculateCharge(1000, "EUR", { ...cfg.currencyRates, EUR: 0 })).toThrow();
    expect(() => calculateCharge(1000000, "HUF", cfg.currencyRates)).toThrow();
    expect(() => calculateCharge(4000.1, "EUR", cfg.currencyRates)).toThrow();
  });
});

describe("signed complete-input short-lived preview offers", () => {
  it("round trips with reordered input keys and normalized address", () => {
    const inputs = syntheticQuoteInputs();
    const offer = buildOffer("owner", inputs, cfg, policy, now);
    expect(verifyOffer(signOffer(offer), "owner", { ...inputs, shippingAddress: { ...inputs.shippingAddress, countryCode: " hu ", postalCode: "10-00" } }, now + 1)).toEqual(offer);
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  });
  it.each(["quantity", "currency", "vaultAddOn", "submissionId"] as const)("binds %s", field => {
    const inputs = syntheticQuoteInputs();
    const token = signOffer(buildOffer("owner", inputs, cfg, policy, now));
    const changes = { quantity: 41, currency: "GBP", vaultAddOn: true, submissionId: "another-book" };
    expect(() => verifyOffer(token, "owner", { ...inputs, [field]: changes[field] }, now)).toThrow(/fresh quote/i);
  });
  it.each(["recipientName", "line1", "line2", "city", "postalCode", "countryCode", "phone"] as const)("binds address %s", field => {
    const inputs = syntheticQuoteInputs();
    const token = signOffer(buildOffer("owner", inputs, cfg, policy, now));
    expect(() => verifyOffer(token, "owner", { ...inputs, shippingAddress: { ...inputs.shippingAddress,
      [field]: field === "countryCode" ? "DE" : "changed" } }, now)).toThrow();
  });
  it("rejects wrong owner, tampering, expiry, future issuance and missing signer", () => {
    const inputs = syntheticQuoteInputs();
    const token = signOffer(buildOffer("owner", inputs, cfg, policy, now));
    expect(() => verifyOffer(token, "other", inputs, now)).toThrow();
    const [payload, signature] = token.split(".");
    const modified = JSON.parse(Buffer.from(payload, "base64url").toString());
    modified.charge.amountMinor = 1;
    expect(() => verifyOffer(`${Buffer.from(JSON.stringify(modified)).toString("base64url")}.${signature}`, "owner", inputs, now)).toThrow();
    expect(() => verifyOffer(token, "owner", inputs, now + OFFER_TTL_MS)).toThrow();
    expect(() => verifyOffer(token, "owner", inputs, now - 1)).toThrow();
    vi.stubEnv("AUTH_SECRET", ""); vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(() => signOffer(buildOffer("owner", inputs, cfg, policy, now))).toThrow(/not configured/i);
  });
  it("preserves original terms/rates/config and requires review after policy changes", () => {
    const offer = buildOffer("owner", syntheticQuoteInputs(), cfg, policy, now);
    const token = signOffer(offer);
    const changedCfg = { ...cfg, version: 99, currencyRates: { HUF: 1, EUR: 0.9, GBP: 0.8 } };
    expect(verifyOffer(token, "owner", syntheticQuoteInputs(), now).charge).toEqual(offer.charge);
    expect(buildOffer("owner", syntheticQuoteInputs(), changedCfg, policy, now).charge).not.toEqual(offer.charge);
    expect(() => assertOfferPolicy(offer, null)).toThrow();
    expect(() => assertOfferPolicy(offer, { ...policy, approvalReference: "new approval" })).toThrow(/fresh quote/i);
    expect(() => assertOfferPolicy(offer, policy)).not.toThrow();
    expect(createOrderInputSchema.safeParse({ ...syntheticQuoteInputs(), offerToken: token,
      requestKey: "b5719d7f-58bd-4a2e-8b7d-a35072b55d63", acceptTerms: false }).success).toBe(false);
  });
  it("normalizes request-key case so an uppercase retry replays the same key", () => {
    const key = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const parsed = createOrderInputSchema.parse({ ...syntheticQuoteInputs(), offerToken: "synthetic-token",
      requestKey: key.toUpperCase(), acceptTerms: true });
    expect(parsed.requestKey).toBe(key);
    expect(createOrderInputSchema.safeParse({ ...syntheticQuoteInputs(), offerToken: "synthetic-token",
      requestKey: "not-a-uuid", acceptTerms: true }).success).toBe(false);
  });
});

describe("weight-aware UX hints", () => {
  it("keeps the sweet-spot tip only while packed weight fits the intended band", () => {
    // 160 copies × 6 g = 960 g sits in the 1000 g band; +50 g packaging
    // crosses into the 2000 g band, so the "fit perfectly" claim must drop.
    const bare = buildUxMessages("hungary", 160, cfg);
    expect(bare.some(message => message.text.includes("sweet spot"))).toBe(true);
    const packed = buildUxMessages("hungary", 160, cfg, { packagingWeightGrams: 50 });
    expect(packed.some(message => message.text.includes("sweet spot"))).toBe(false);
  });
  it("does not recommend a price break above the approved shipment cap", () => {
    // (5 + 2 vault copies) × 6 g + 20 g = 62 g fits a 70 g cap; the 8-copy
    // break weighs (8 + 2) × 6 + 20 = 80 g and must not be recommended.
    const options = { packagingWeightGrams: 20, shippedExtraCopies: 2, maxWeightGrams: 70 };
    const capped = buildUxMessages("hungary", 5, cfg, options);
    expect(capped.some(message => message.text.includes("next price break"))).toBe(false);
    // The exact-cap quantity stays eligible: 80 g weight at an 80 g cap.
    const atCap = buildUxMessages("hungary", 5, cfg, { ...options, maxWeightGrams: 80 });
    expect(atCap.some(message => message.text.includes("next price break at 8 copies"))).toBe(true);
  });
});

describe("strict legacy/new tariff normalization", () => {
  it("preserves intentional legacy null rates and never substitutes a default", () => {
    const table = strictShippingTable({ hungary: [100, 200, null], eu: [300, null, null] }, [50, 100, 250]);
    expect(table.hungary).toEqual([{ maxWeightGrams: 50, priceHuf: 100 }, { maxWeightGrams: 100, priceHuf: 200 }]);
    expect(table.canada).toEqual([]);
    expect(strictShippingTable(cfg.shippingTable, []).hungary).toEqual(cfg.shippingTable.hungary);
  });
  it("preserves and tests every synthetic five-zone legacy tariff/tier boundary without default substitution", () => {
    const caps = [50, 100, 250, 500, 1000, 2000];
    const raw = { hungary: [271, 307, 367, 541, 847, 1631], eu: [1251, 1601, 2201, 3601, 6001, 10001],
      uk: [1301, 1651, 2301, 3701, 6201, 10201], usa: [1551, 2001, 3001, 5001, 8501, 14001],
      rest_of_world: [1552, 2002, 3002, 5002, 8502, 14002] };
    const before = JSON.stringify(raw);
    const legacyCfg = { ...cfg, shippingTable: strictShippingTable(raw, caps),
      priceTiers: [{ min: 1, max: 12, pricePerCopy: 321 }, { min: 13, max: 59, pricePerCopy: 234 },
        { min: 60, max: Number.MAX_SAFE_INTEGER, pricePerCopy: 187 }] };
    for (const zone of Object.keys(raw) as Array<keyof typeof raw>) {
      caps.forEach((cap, index) => {
        for (const weight of [cap - 1, cap, cap + 1]) {
          const expected = caps.findIndex(ceiling => weight <= ceiling);
          expect(getShippingBand(zone, weight, legacyCfg)).toBe(expected);
        }
        const ceiling = bandCeilingQuantity(zone, index, legacyCfg, { packagingWeightGrams: 20, shippedExtraCopies: 2 });
        for (const q of [ceiling - 1, ceiling, ceiling + 1].filter(q => q > 0)) {
          const weight = calculateWeight(q, legacyCfg, { packagingWeightGrams: 20, shippedExtraCopies: 2 });
          const expected = caps.findIndex(cap => weight <= cap);
          if (expected < 0) expect(() => calculateOrder(zone, q, legacyCfg, { packagingWeightGrams: 20, shippedExtraCopies: 2 })).toThrow();
          else expect(calculateOrder(zone, q, legacyCfg, { packagingWeightGrams: 20, shippedExtraCopies: 2 }).shippingCostHuf).toBe(raw[zone][expected]);
        }
      });
      for (const boundary of [12, 13, 59, 60]) for (const q of [boundary - 1, boundary, boundary + 1]) {
        expect(calculateOrder(zone, q, legacyCfg).unitPriceHuf).toBe(legacyCfg.priceTiers.find(tier => q >= tier.min && q <= tier.max)?.pricePerCopy);
      }
    }
    expect(resolveDestination("HU", "1000", false, legacyCfg, policy).maxWeightGrams).toBe(2000);
    expect(() => buildOffer("owner", { ...syntheticQuoteInputs(), quantity: 334 }, legacyCfg, policy, now)).toThrow(/manual quote/i);
    expect(legacyCfg.shippingTable.canada).toEqual([]);
    expect(() => calculateOrder("canada", 1, legacyCfg)).toThrow();
    expect(JSON.stringify(raw)).toBe(before);
  });
  it.each([
    { hungary: [100, "spoof"] }, { hungary: [-1, 100] }, { hungary: [Infinity, 100] },
    { hungary: [{ maxWeightGrams: 100, priceHuf: 100 }, { maxWeightGrams: 50, priceHuf: 200 }] },
    { hungary: [{ maxWeightGrams: 100, priceHuf: 100.5 }] }, { unknown: [100, 200] },
  ])("rejects malformed tariff %j", raw => { expect(() => strictShippingTable(raw, [50, 100])).toThrow(); });
});
