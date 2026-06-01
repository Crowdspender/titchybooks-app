import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { loadPricingConfig } from "@/lib/pricing/config";

export const dynamic = "force-dynamic";


/**
 * Returns the public-safe portion of the pricing config so the editor's
 * Order panel can render zone selectors and tier ladders without exposing
 * admin-only metadata. Authenticated users only.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cfg = await loadPricingConfig();
  return NextResponse.json({
    enabledZones: cfg.enabledZones,
    weightBands: cfg.weightBands,
    weightPerBookGrams: cfg.weightPerBookGrams,
    priceTiers: cfg.priceTiers,
    shippingTable: Object.fromEntries(
      cfg.enabledZones.map((zone) => [zone, cfg.shippingTable[zone]])
    ),
    handlingFixedHuf: cfg.handlingFixedHuf,
    handlingPercent: cfg.handlingPercent,
    currencyRates: cfg.currencyRates,
    pricingConfigVersion: cfg.version,
  });
}
