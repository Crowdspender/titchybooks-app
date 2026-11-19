import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { loadCheckoutPricingConfig } from "@/lib/pricing/config";
import { suggestOptimalQuantity, type UxMessage } from "@/lib/pricing/engine";
import { calculateOrderInputSchema } from "@/lib/pricing/schema";
import { loadShippingPolicy, ManualQuoteRequired } from "@/lib/pricing/destination";
import { buildOffer, signOffer } from "@/lib/pricing/offer";
import { consumeRateLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";


export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await consumeRateLimit(`quote:user:${session.user.id}`, { limit: 120, windowMs: 60_000 });
  if (!rl.allowed) return tooManyRequests(rl, "Too many quote requests. Please try again shortly.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = calculateOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message, issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const submission = await prisma.submission.findUnique({
    where: { id: parsed.data.submissionId },
    select: { id: true, userId: true, status: true, pdfS3Key: true },
  });
  if (!submission) return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  if (submission.userId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (submission.status !== "APPROVED" || !submission.pdfS3Key) {
    return NextResponse.json({ error: "Only approved books with a print PDF can be quoted" }, { status: 400 });
  }

  try {
    const policy = loadShippingPolicy();
    if (!policy) throw new ManualQuoteRequired();
    const cfg = await loadCheckoutPricingConfig();
    const offer = buildOffer(session.user.id, parsed.data, cfg, policy);
    const order = offer.calculation;
    const options = { ...offer.shipping.destination, vaultAddOn: parsed.data.vaultAddOn };
    const candidate = suggestOptimalQuantity(order.zone, order.quantity, cfg, options);
    const suggestion = candidate &&
      (candidate.suggestedQuantity + options.shippedExtraCopies) * cfg.weightPerBookGrams + options.packagingWeightGrams <= options.maxWeightGrams
      ? candidate : null;
    // Suggestions use the actual approved parcel rule; canonical default
    // quantities cannot claim to fit a shipping band after packaging changes.
    const messages: UxMessage[] = suggestion && suggestion.savingsPct >= 5
      ? [{ level: "tip", text: `Ordering ${suggestion.suggestedQuantity} copies reduces cost per book by ${suggestion.savingsPct}%. Request a new quote to review this change.` }]
      : [];

    return NextResponse.json({
      order,
      suggestion,
      messages,
      currency: offer.charge.currency,
      offer: { token: signOffer(offer), inputs: offer.inputs, expiresAt: offer.expiresAt,
        charge: offer.charge, terms: offer.terms, service: offer.shipping.destination.service },
      meta: {
        enabledZones: cfg.enabledZones,
        priceTiers: cfg.priceTiers,
        weightPerBookGrams: cfg.weightPerBookGrams,
        currencyRates: cfg.currencyRates,
        pricingConfigVersion: cfg.version,
        vaultFeeHuf: cfg.vaultFeeHuf,
      },
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Calculation unavailable",
        ...(error instanceof ManualQuoteRequired ? { code: error.code, contactUrl: "/contact?topic=unlisted_region" } : {}) },
      { status: error instanceof ManualQuoteRequired ? 422 : 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
