/**
 * Pricing engine unit tests.
 *
 * No test runner is configured in package.json (only `tsx` is available),
 * so these tests are written as a plain script using `node:assert/strict`.
 *
 * Run with:
 *   npx tsx src/lib/pricing/__tests__/engine.test.ts
 *
 * Each `test(label, fn)` block isolates failures so a single broken case
 * does not abort the entire run; the script exits non-zero if any test
 * fails, which makes it CI-friendly.
 */

import assert from "node:assert/strict";

import {
  DEFAULT_RESOLVED_CONFIG,
  MAX_SHIPMENT_WEIGHT_GRAMS,
  OPEN_ENDED_TIER_MAX,
  type ResolvedPricingConfig,
} from "../constants";
import {
  bandCeilingQuantity,
  buildUxMessages,
  calculateOrder,
  calculateWeight,
  findTier,
  getHandlingCost,
  getShippingBand,
  getShippingCost,
  getShippingLadder,
  getUnitPrice,
  maxShipmentWeight,
  suggestOptimalQuantity,
} from "../engine";
import { normaliseShippingTable } from "../shipping";
import {
  calculateOrderInputSchema,
  createOrderInputSchema,
  pricingConfigInputSchema,
} from "../schema";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`  FAIL ${name}`);
    console.error(message);
  }
}

function group(label: string, fn: () => void): void {
  console.log(`\n${label}`);
  fn();
}

/** Returns a fresh deep clone so tests can mutate freely. */
function defaultConfig(): ResolvedPricingConfig {
  return JSON.parse(JSON.stringify(DEFAULT_RESOLVED_CONFIG)) as ResolvedPricingConfig;
}

// ---------------------------------------------------------------------------
// calculateWeight
// ---------------------------------------------------------------------------

group("calculateWeight", () => {
  const cfg = defaultConfig();

  test("multiplies quantity by per-book grams", () => {
    assert.equal(calculateWeight(1, cfg), 6);
    assert.equal(calculateWeight(8, cfg), 48);
    assert.equal(calculateWeight(40, cfg), 240);
    assert.equal(calculateWeight(333, cfg), 1998);
    assert.equal(calculateWeight(6666, cfg), 39996);
  });

  test("respects an admin override of weightPerBookGrams", () => {
    const heavier = defaultConfig();
    heavier.weightPerBookGrams = 10;
    assert.equal(calculateWeight(8, heavier), 80);
  });
});

// ---------------------------------------------------------------------------
// getShippingBand — per-zone boundary cases
// ---------------------------------------------------------------------------

group("getShippingBand", () => {
  const cfg = defaultConfig();

  test("returns -1 for non-positive weight", () => {
    assert.equal(getShippingBand("hungary", 0, cfg), -1);
    assert.equal(getShippingBand("hungary", -5, cfg), -1);
  });

  test("uses the domestic letter ladder up to 2 kg", () => {
    assert.equal(getShippingBand("hungary", 1, cfg), 0);
    assert.equal(getShippingBand("hungary", 50, cfg), 0);
    assert.equal(getShippingBand("hungary", 51, cfg), 1);
    assert.equal(getShippingBand("hungary", 2000, cfg), 5);
  });

  test("switches to domestic parcels above 2 kg", () => {
    assert.equal(getShippingBand("hungary", 2001, cfg), 6); // 5 kg parcel
    assert.equal(getShippingBand("hungary", 40000, cfg), 10); // 40 kg parcel
    assert.equal(getShippingBand("hungary", 40001, cfg), -1);
  });

  test("enforces each zone's carrier ceiling", () => {
    assert.equal(maxShipmentWeight("hungary", cfg), MAX_SHIPMENT_WEIGHT_GRAMS);
    assert.equal(maxShipmentWeight("eu", cfg), 31500);
    assert.equal(maxShipmentWeight("uk", cfg), 30000);
    assert.equal(maxShipmentWeight("usa", cfg), 10000);
    assert.equal(maxShipmentWeight("canada", cfg), 2000);
    assert.equal(getShippingBand("eu", 31500, cfg), 11);
    assert.equal(getShippingBand("usa", 10001, cfg), -1);
  });
});

// ---------------------------------------------------------------------------
// findTier / getUnitPrice — boundary cases
// ---------------------------------------------------------------------------

group("findTier / getUnitPrice", () => {
  const cfg = defaultConfig();

  test("returns the right tier on each interior boundary", () => {
    assert.equal(getUnitPrice(1, cfg), 300);
    assert.equal(getUnitPrice(7, cfg), 300);
    assert.equal(getUnitPrice(8, cfg), 250);
    assert.equal(getUnitPrice(9, cfg), 250);
    assert.equal(getUnitPrice(40, cfg), 250);
    assert.equal(getUnitPrice(41, cfg), 220);
    assert.equal(getUnitPrice(80, cfg), 220);
    assert.equal(getUnitPrice(81, cfg), 190);
    assert.equal(getUnitPrice(160, cfg), 190);
    assert.equal(getUnitPrice(161, cfg), 170);
    assert.equal(getUnitPrice(333, cfg), 170);
    assert.equal(getUnitPrice(334, cfg), 150);
    assert.equal(getUnitPrice(1000, cfg), 150);
    assert.equal(getUnitPrice(OPEN_ENDED_TIER_MAX, cfg), 150);
  });

  test("findTier returns null when no tier covers the quantity", () => {
    assert.equal(findTier(0, cfg.priceTiers), null);
    assert.equal(findTier(-1, cfg.priceTiers), null);
  });

  test("getUnitPrice throws when no tier matches", () => {
    const capped = defaultConfig();
    capped.priceTiers = [{ min: 1, max: 333, pricePerCopy: 170 }];
    assert.throws(() => getUnitPrice(334, capped), /No pricing tier/);
    assert.throws(() => getUnitPrice(0, cfg), /No pricing tier/);
  });

  test("matches the recommended profit at a 110 HUF production cost", () => {
    for (const [quantity, profit] of [
      [1, 190], [8, 140], [41, 110], [81, 80], [161, 60], [334, 40],
    ]) {
      assert.equal(getUnitPrice(quantity, cfg) - 110, profit);
    }
  });

  test("keeps all six tiers valid after a JSON round trip", () => {
    const parsed = pricingConfigInputSchema.parse(
      JSON.parse(JSON.stringify(cfg))
    );
    assert.equal(parsed.priceTiers.length, 6);
    assert.deepEqual(parsed.priceTiers, cfg.priceTiers);
    assert.equal(parsed.priceTiers[5].max, OPEN_ENDED_TIER_MAX);
    assert.equal(getUnitPrice(334, { ...cfg, ...parsed }), 150);
  });

  test("preserves the checkout quantity limit independently of pricing", () => {
    for (const quantitySchema of [
      calculateOrderInputSchema.shape.quantity,
      createOrderInputSchema.shape.quantity,
    ]) {
      assert.equal(quantitySchema.safeParse(6666).success, true);
      assert.equal(quantitySchema.safeParse(6667).success, false);
    }
  });
});

// ---------------------------------------------------------------------------
// getShippingCost
// ---------------------------------------------------------------------------

group("getShippingCost", () => {
  const cfg = defaultConfig();

  test("matches the domestic letter and parcel tariff", () => {
    assert.equal(getShippingCost("hungary", 1, cfg), 270); // 6g
    assert.equal(getShippingCost("hungary", 8, cfg), 270); // 48g
    assert.equal(getShippingCost("hungary", 9, cfg), 305); // 54g
    assert.equal(getShippingCost("hungary", 40, cfg), 365); // 240g
    assert.equal(getShippingCost("hungary", 80, cfg), 540); // 480g
    assert.equal(getShippingCost("hungary", 160, cfg), 845); // 960g
    assert.equal(getShippingCost("hungary", 333, cfg), 1630); // 1998g
    assert.equal(getShippingCost("hungary", 833, cfg), 3460); // 4998g -> 5kg
    assert.equal(getShippingCost("hungary", 1666, cfg), 3770); // 10kg
    assert.equal(getShippingCost("hungary", 3333, cfg), 4610); // 20kg
    assert.equal(getShippingCost("hungary", 5000, cfg), 6930); // 30kg
    assert.equal(getShippingCost("hungary", 6666, cfg), 9660); // 40kg
  });

  test("matches the MPL Europe Standard tiers", () => {
    assert.equal(getShippingCost("eu", 8, cfg), 1250);
    assert.equal(getShippingCost("eu", 40, cfg), 2200);
    assert.equal(getShippingCost("eu", 80, cfg), 3600);
    assert.equal(getShippingCost("eu", 833, cfg), 12500); // 5kg
    assert.equal(getShippingCost("eu", 5250, cfg), 41000); // 31.5kg ceiling
  });

  test("matches the UK and USA parcel tiers", () => {
    assert.equal(getShippingCost("uk", 5000, cfg), 94000); // 30kg
    assert.equal(getShippingCost("usa", 1666, cfg), 49000); // 10kg
  });

  test("throws when zone is not configured", () => {
    assert.throws(
      () => getShippingCost("mars" as unknown as "eu", 1, cfg),
      /not configured/
    );
  });

  test("throws once a zone's carrier ceiling is exceeded", () => {
    assert.throws(
      () => getShippingCost("usa", 1667, cfg),
      /10 kg limit for United States/
    );
    assert.throws(
      () => getShippingCost("hungary", 6667, cfg),
      /40 kg limit for Hungary/
    );
  });
});

// ---------------------------------------------------------------------------
// normaliseShippingTable — legacy matrix upgrade
// ---------------------------------------------------------------------------

group("normaliseShippingTable", () => {
  test("upgrades a legacy price matrix using the shared weight bands", () => {
    const table = normaliseShippingTable(
      { hungary: [270, 305, null, 540] },
      [50, 100, 250, 500]
    );
    assert.deepEqual(table.hungary, [
      { maxWeightGrams: 50, priceHuf: 270 },
      { maxWeightGrams: 100, priceHuf: 305 },
      { maxWeightGrams: 500, priceHuf: 540 },
    ]);
    assert.deepEqual(table.eu, []);
  });

  test("keeps the new ladder shape and sorts it by weight", () => {
    const table = normaliseShippingTable(
      {
        eu: [
          { maxWeightGrams: 5000, priceHuf: 12500 },
          { maxWeightGrams: 2000, priceHuf: 10000 },
        ],
      },
      null
    );
    assert.deepEqual(table.eu, [
      { maxWeightGrams: 2000, priceHuf: 10000 },
      { maxWeightGrams: 5000, priceHuf: 12500 },
    ]);
    assert.deepEqual(table.usa, []);
  });

  test("feeds the engine after an upgrade", () => {
    const cfg = defaultConfig();
    cfg.shippingTable = normaliseShippingTable(
      {
        hungary: [
          270, 305, 365, 540, 845, 1630, 3460, 3770, 4610, 6930, 9660,
        ],
      },
      [
        50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 30000, 40000,
      ]
    );
    assert.equal(getShippingLadder("hungary", cfg).length, 11);
    assert.equal(maxShipmentWeight("hungary", cfg), MAX_SHIPMENT_WEIGHT_GRAMS);
    assert.equal(getShippingCost("hungary", 833, cfg), 3460);
  });
});

// ---------------------------------------------------------------------------
// getHandlingCost
// ---------------------------------------------------------------------------

group("getHandlingCost", () => {
  test("returns 0 when both fixed and percent are 0", () => {
    const cfg = defaultConfig();
    assert.equal(getHandlingCost(10000, cfg), 0);
  });

  test("adds fixed fee", () => {
    const cfg = defaultConfig();
    cfg.handlingFixedHuf = 250;
    assert.equal(getHandlingCost(10000, cfg), 250);
  });

  test("adds percentage of print cost (ceil)", () => {
    const cfg = defaultConfig();
    cfg.handlingPercent = 5;
    // 5% of 10001 = 500.05 -> ceil to 501
    assert.equal(getHandlingCost(10001, cfg), 501);
  });

  test("combines fixed + percent", () => {
    const cfg = defaultConfig();
    cfg.handlingFixedHuf = 200;
    cfg.handlingPercent = 10;
    assert.equal(getHandlingCost(5000, cfg), 200 + 500);
  });
});

// ---------------------------------------------------------------------------
// calculateOrder — totals with and without handling
// ---------------------------------------------------------------------------

group("calculateOrder", () => {
  test("computes the spec example order (eu, 40 copies)", () => {
    const cfg = defaultConfig();
    const result = calculateOrder("eu", 40, cfg);

    assert.equal(result.quantity, 40);
    assert.equal(result.zone, "eu");
    assert.equal(result.weightGrams, 240);
    assert.equal(result.shippingBand, 2);
    assert.equal(result.unitPriceHuf, 250);
    assert.equal(result.printCostHuf, 10000);
    assert.equal(result.handlingCostHuf, 0);
    assert.equal(result.shippingCostHuf, 2200);
    assert.equal(result.discountHuf, 0);
    assert.equal(result.totalHuf, 12200);
    assert.equal(result.costPerBookHuf, Math.round(12200 / 40));
    assert.equal(result.currency, "HUF");
  });

  test("includes handling fee when configured", () => {
    const cfg = defaultConfig();
    cfg.handlingFixedHuf = 300;
    cfg.handlingPercent = 2;

    const result = calculateOrder("hungary", 8, cfg);
    // print = 250 * 8 = 2000; handling = 300 + ceil(2% of 2000)=40 -> 340
    // shipping = 270; total = 2000 + 340 + 270 = 2610
    assert.equal(result.printCostHuf, 2000);
    assert.equal(result.handlingCostHuf, 340);
    assert.equal(result.shippingCostHuf, 270);
    assert.equal(result.totalHuf, 2610);
    assert.equal(result.costPerBookHuf, Math.round(2610 / 8));
  });

  test("subtracts a discount but never goes negative", () => {
    const cfg = defaultConfig();
    const result = calculateOrder("hungary", 8, cfg, {
      discount: { fixedHuf: 5000, percent: 10 },
    });
    // print = 2000, percent disc = floor(200) = 200, fixed = 5000
    // total raw = 2000 + 0 + 270 - 5200 = -2930 -> clamped to 0
    assert.equal(result.totalHuf, 0);
    assert.equal(result.discountHuf, 5200);
  });

  test("throws once the destination carrier ceiling is exceeded", () => {
    const cfg = defaultConfig();
    assert.throws(
      () => calculateOrder("usa", 1667, cfg),
      /10 kg limit for United States/
    );
    assert.throws(
      () => calculateOrder("hungary", 6667, cfg),
      /40 kg limit for Hungary/
    );
  });

  test("prices a domestic 40 kg order in the top parcel band", () => {
    const cfg = defaultConfig();
    const result = calculateOrder("hungary", 6666, cfg);
    assert.equal(result.weightGrams, 39996);
    assert.equal(result.shippingBand, 10);
    assert.equal(result.unitPriceHuf, 150);
    assert.equal(result.printCostHuf, 999900);
    assert.equal(result.shippingCostHuf, 9660);
    assert.equal(result.totalHuf, 1009560);
  });

  test("prices a USA order inside the 10 kg postal cap", () => {
    const cfg = defaultConfig();
    const result = calculateOrder("usa", 1666, cfg);
    assert.equal(result.weightGrams, 9996);
    assert.equal(result.shippingBand, 7);
    assert.equal(result.shippingCostHuf, 49000);
  });
});

// ---------------------------------------------------------------------------
// bandCeilingQuantity
// ---------------------------------------------------------------------------

group("bandCeilingQuantity", () => {
  const cfg = defaultConfig();

  test("walks the domestic letter and parcel ladders", () => {
    assert.equal(bandCeilingQuantity("hungary", 0, cfg), 8); // 50/6 -> 8
    assert.equal(bandCeilingQuantity("hungary", 1, cfg), 16); // 100/6 -> 16
    assert.equal(bandCeilingQuantity("hungary", 2, cfg), 41); // 250/6 -> 41
    assert.equal(bandCeilingQuantity("hungary", 3, cfg), 83); // 500/6 -> 83
    assert.equal(bandCeilingQuantity("hungary", 4, cfg), 166); // 1000/6 -> 166
    assert.equal(bandCeilingQuantity("hungary", 5, cfg), 333); // 2000/6 -> 333
    assert.equal(bandCeilingQuantity("hungary", 6, cfg), 833); // 5 kg parcel
    assert.equal(bandCeilingQuantity("hungary", 10, cfg), 6666); // 40 kg parcel
  });

  test("stops at each zone's own ceiling", () => {
    assert.equal(bandCeilingQuantity("eu", 11, cfg), 5250); // 31.5 kg
    assert.equal(bandCeilingQuantity("usa", 7, cfg), 1666); // 10 kg
    assert.equal(bandCeilingQuantity("canada", 5, cfg), 333); // letters only
  });

  test("returns 0 for an out-of-range band", () => {
    assert.equal(bandCeilingQuantity("hungary", 99, cfg), 0);
  });
});

// ---------------------------------------------------------------------------
// suggestOptimalQuantity — only when true savings exist
// ---------------------------------------------------------------------------

group("suggestOptimalQuantity", () => {
  test("suggests jumping from 7 to 8 (sweet spot, lower per-book)", () => {
    const cfg = defaultConfig();
    const suggestion = suggestOptimalQuantity("eu", 7, cfg);
    assert.notEqual(suggestion, null);
    assert.ok(
      suggestion!.suggestedQuantity > 7,
      "should propose a larger quantity"
    );
    assert.ok(
      suggestion!.suggestedCostPerBook < suggestion!.currentCostPerBook,
      "suggested option must be strictly cheaper"
    );
  });

  test("suggests 41 over 32 (next tier + new band)", () => {
    const cfg = defaultConfig();
    const suggestion = suggestOptimalQuantity("eu", 32, cfg);
    assert.notEqual(suggestion, null);
    assert.ok(suggestion!.suggestedQuantity >= 41);
    assert.ok(suggestion!.savingsPct > 0);
  });

  test("returns null once the order already fills the top band", () => {
    const cfg = defaultConfig();
    const suggestion = suggestOptimalQuantity("hungary", 6666, cfg);
    assert.equal(suggestion, null);
  });

  test("returns null when no candidate beats current cost-per-book", () => {
    // With a flat tier table and identical shipping per band, no jump can
    // produce a cheaper per-book figure.
    const cfg = defaultConfig();
    cfg.priceTiers = [{ min: 1, max: 333, pricePerCopy: 100 }];
    const flatLadder = Array.from({ length: 12 }, (_, i) => ({
      maxWeightGrams: (i + 1) * 4000,
      priceHuf: 0,
    }));
    for (const zone of cfg.enabledZones) {
      cfg.shippingTable[zone] = flatLadder.map((band) => ({ ...band }));
    }
    const suggestion = suggestOptimalQuantity("eu", 333, cfg);
    assert.equal(suggestion, null);
  });
});

// ---------------------------------------------------------------------------
// buildUxMessages
// ---------------------------------------------------------------------------

group("buildUxMessages", () => {
  test("flags the canonical sweet spots", () => {
    const cfg = defaultConfig();
    for (const q of [8, 40, 80]) {
      const messages = buildUxMessages("eu", q, cfg);
      assert.ok(
        messages.some((m) => m.level === "tip" && m.text.includes("sweet spot")),
        `expected sweet-spot tip at quantity ${q}`
      );
    }
  });

  test("warns when the order exceeds the zone's weight cap", () => {
    const cfg = defaultConfig();
    const messages = buildUxMessages("usa", 1667, cfg);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].level, "warning");
    assert.ok(messages[0].text.includes("10 kg limit for United States"));
  });

  test("hints at the next price break when within the window", () => {
    const cfg = defaultConfig();
    const messages = buildUxMessages("eu", 38, cfg);
    assert.ok(
      messages.some((m) => m.text.includes("next price break")),
      "expected near-break hint at 38 copies"
    );
  });
});

// ---------------------------------------------------------------------------
// Summary / exit code
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
