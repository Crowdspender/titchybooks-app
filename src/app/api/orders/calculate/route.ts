import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { loadPricingConfig } from "@/lib/pricing/config";
import {
  buildUxMessages,
  calculateOrder,
  suggestOptimalQuantity,
} from "@/lib/pricing/engine";
import { calculateOrderInputSchema } from "@/lib/pricing/schema";
import { DEFAULT_CURRENCY } from "@/lib/pricing/currency";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const { submissionId, zone, quantity, currency } = parsed.data;
  const selectedCurrency = currency ?? DEFAULT_CURRENCY;
  const cfg = await loadPricingConfig();

  if (!cfg.enabledZones.includes(zone)) {
    return NextResponse.json(
      { error: `Shipping to ${zone} is currently disabled` },
      { status: 400 }
    );
  }

  if (submissionId) {
    const submission = await prisma.submission.findUnique({
      where: { id: submissionId },
      select: { id: true, userId: true, status: true, pdfS3Key: true },
    });
    if (!submission) {
      return NextResponse.json({ error: "Submission not found" }, { status: 404 });
    }
    if (
      submission.userId !== session.user.id &&
      session.user.role !== "ADMIN"
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    const order = calculateOrder(zone, quantity, cfg);
    const suggestion = suggestOptimalQuantity(zone, quantity, cfg);
    const messages = buildUxMessages(zone, quantity, cfg);

    return NextResponse.json({
      order,
      suggestion,
      messages,
      currency: selectedCurrency,
      meta: {
        enabledZones: cfg.enabledZones,
        priceTiers: cfg.priceTiers,
        weightBands: cfg.weightBands,
        weightPerBookGrams: cfg.weightPerBookGrams,
        currencyRates: cfg.currencyRates,
        pricingConfigVersion: cfg.version,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Calculation failed",
      },
      { status: 400 }
    );
  }
}
