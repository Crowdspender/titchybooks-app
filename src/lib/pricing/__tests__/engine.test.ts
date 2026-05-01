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
  type ResolvedPricingConfig,
} from "../constants";
import {
  bandCeilingQuantity,
  buildUxMessages,
  calculateOrder,
  calculateWeight,
  findTier,
  getHandlingCost,
  getShippingCost,
  getUnitPrice,
  getWeightBand,
  suggestOptimalQuantity,
} from "../engine";

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
  });

  test("respects an admin override of weightPerBookGrams", () => {
    const heavier = defaultConfig();
    heavier.weightPerBookGrams = 10;
    assert.equal(calculateWeight(8, heavier), 80);
  });
});

// ---------------------------------------------------------------------------
// getWeightBand — boundary cases
// ---------------------------------------------------------------------------

group("getWeightBand", () => {
  const cfg = defaultConfig();

  test("returns -1 for non-positive weight", () => {
    assert.equal(getWeightBand(0, cfg), -1);
    assert.equal(getWeightBand(-5, cfg), -1);
  });

  test("snaps to band 0 at and below 50g", () => {
    assert.equal(getWeightBand(1, cfg), 0);
    assert.equal(getWeightBand(50, cfg), 0);
  });

  test("crosses to band 1 at 51g", () => {
    assert.equal(getWeightBand(51, cfg), 1);
    assert.equal(getWeightBand(100, cfg), 1);
  });

  test("upper-inclusive on every middle band", () => {
    assert.equal(getWeightBand(101, cfg), 2); // > 100 -> 250 band
    assert.equal(getWeightBand(250, cfg), 2);
    assert.equal(getWeightBand(251, cfg), 3);
    assert.equal(getWeightBand(500, cfg), 3);
    assert.equal(getWeightBand(501, cfg), 4);
    assert.equal(getWeightBand(1000, cfg), 4);
    assert.equal(getWeightBand(1001, cfg), 5);
  });

  test("treats exactly 2000g as last band, 2001g as overflow", () => {
    assert.equal(getWeightBand(MAX_SHIPMENT_WEIGHT_GRAMS, cfg), 5);
    assert.equal(getWeightBand(MAX_SHIPMENT_WEIGHT_GRAMS + 1, cfg), -1);
  });
});

// ---------------------------------------------------------------------------
// findTier / getUnitPrice — boundary cases
// ---------------------------------------------------------------------------

group("findTier / getUnitPrice", () => {
  const cfg = defaultConfig();

  test("returns the right tier on each interior boundary", () => {
    assert.equal(getUnitPrice(1, cfg), 300);
    assert.equal(getUnitPrice(8, cfg), 300);
    assert.equal(getUnitPrice(9, cfg), 180);
    assert.equal(getUnitPrice(40, cfg), 180);
    assert.equal(getUnitPrice(41, cfg), 120);
    assert.equal(getUnitPrice(80, cfg), 120);
    assert.equal(getUnitPrice(81, cfg), 90);
    assert.equal(getUnitPrice(160, cfg), 90);
    assert.equal(getUnitPrice(161, cfg), 70);
    assert.equal(getUnitPrice(333, cfg), 70);
  });

  test("findTier returns null when no tier covers the quantity", () => {
    assert.equal(findTier(0, cfg.priceTiers), null);
    assert.equal(findTier(334, cfg.priceTiers), null);
  });

  test("getUnitPrice throws when no tier matches", () => {
    assert.throws(() => getUnitPrice(334, cfg), /No pricing tier/);
    assert.throws(() => getUnitPrice(0, cfg), /No pricing tier/);
  });
});

// ---------------------------------------------------------------------------
// getShippingCost
// ---------------------------------------------------------------------------

group("getShippingCost", () => {
  const cfg = defaultConfig();

  test("matches the spec table for hungary", () => {
    assert.equal(getShippingCost("hungary", 1, cfg), 270); // 6g  -> band 0
    assert.equal(getShippingCost("hungary", 8, cfg), 270); // 48g -> band 0
    assert.equal(getShippingCost("hungary", 9, cfg), 305); // 54g -> band 1
    assert.equal(getShippingCost("hungary", 40, cfg), 365); // 240g -> band 2
    assert.equal(getShippingCost("hungary", 80, cfg), 540); // 480g -> band 3
    assert.equal(getShippingCost("hungary", 160, cfg), 845); // 960g -> band 4
    assert.equal(getShippingCost("hungary", 333, cfg), 1630); // 1998g -> band 5
  });

  test("matches the spec table for eu", () => {
    assert.equal(getShippingCost("eu", 8, cfg), 1250);
    assert.equal(getShippingCost("eu", 40, cfg), 2200);
    assert.equal(getShippingCost("eu", 80, cfg), 3600);
  });

  test("throws when zone is not configured", () => {
    assert.throws(
      () => getShippingCost("mars" as unknown as "eu", 1, cfg),
      /not configured/
    );
  });

  test("throws when shipment exceeds the weight cap", () => {
    assert.throws(() => getShippingCost("eu", 334, cfg), /exceeds the 2000g/);
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
    assert.equal(result.unitPriceHuf, 180);
    assert.equal(result.printCostHuf, 7200);
    assert.equal(result.handlingCostHuf, 0);
    assert.equal(result.shippingCostHuf, 2200);
    assert.equal(result.discountHuf, 0);
    assert.equal(result.totalHuf, 9400);
    assert.equal(result.costPerBookHuf, Math.round(9400 / 40));
    assert.equal(result.currency, "HUF");
  });

  test("includes handling fee when configured", () => {
    const cfg = defaultConfig();
    cfg.handlingFixedHuf = 300;
    cfg.handlingPercent = 2;

    const result = calculateOrder("hungary", 8, cfg);
    // print = 300 * 8 = 2400; handling = 300 + ceil(2% of 2400)=48 -> 348
    // shipping = 270; total = 2400 + 348 + 270 = 3018
    assert.equal(result.printCostHuf, 2400);
    assert.equal(result.handlingCostHuf, 348);
    assert.equal(result.shippingCostHuf, 270);
    assert.equal(result.totalHuf, 3018);
    assert.equal(result.costPerBookHuf, Math.round(3018 / 8));
  });

  test("subtracts a discount but never goes negative", () => {
    const cfg = defaultConfig();
    const result = calculateOrder("hungary", 8, cfg, {
      discount: { fixedHuf: 5000, percent: 10 },
    });
    // print = 2400, percent disc = floor(240) = 240, fixed = 5000
    // total raw = 2400 + 0 + 270 - 5240 = -2570 -> clamped to 0
    assert.equal(result.totalHuf, 0);
    assert.equal(result.discountHuf, 5240);
  });

  test("throws when shipment exceeds weight cap", () => {
    const cfg = defaultConfig();
    assert.throws(() => calculateOrder("eu", 334, cfg), /exceeds the 2000g/);
  });
});

// ---------------------------------------------------------------------------
// bandCeilingQuantity
// ---------------------------------------------------------------------------

group("bandCeilingQuantity", () => {
  const cfg = defaultConfig();

  test("returns the maximum books that still fit each band", () => {
    assert.equal(bandCeilingQuantity(0, cfg), 8); // 50/6 -> 8
    assert.equal(bandCeilingQuantity(1, cfg), 16); // 100/6 -> 16
    assert.equal(bandCeilingQuantity(2, cfg), 41); // 250/6 -> 41
    assert.equal(bandCeilingQuantity(3, cfg), 83); // 500/6 -> 83
    assert.equal(bandCeilingQuantity(4, cfg), 166); // 1000/6 -> 166
    assert.equal(bandCeilingQuantity(5, cfg), 333); // 2000/6 -> 333
  });

  test("returns 0 for an out-of-range band", () => {
    assert.equal(bandCeilingQuantity(99, cfg), 0);
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

  test("returns null at the cheapest band ceiling (333)", () => {
    const cfg = defaultConfig();
    const suggestion = suggestOptimalQuantity("eu", 333, cfg);
    assert.equal(suggestion, null);
  });

  test("returns null when no candidate beats current cost-per-book", () => {
    // With a flat tier table and identical shipping per band, no jump can
    // produce a cheaper per-book figure.
    const cfg = defaultConfig();
    cfg.priceTiers = [{ min: 1, max: 333, pricePerCopy: 100 }];
    for (const zone of cfg.enabledZones) {
      cfg.shippingTable[zone] = [500, 500, 500, 500, 500, 500];
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

  test("warns when the order exceeds the weight cap", () => {
    const cfg = defaultConfig();
    const messages = buildUxMessages("eu", 334, cfg);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].level, "warning");
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
