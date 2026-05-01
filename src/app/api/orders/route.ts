import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmissionStatus } from "@/lib/constants";
import { loadPricingConfig } from "@/lib/pricing/config";
import { calculateOrder } from "@/lib/pricing/engine";
import { createOrderInputSchema } from "@/lib/pricing/schema";
import { DEFAULT_CURRENCY } from "@/lib/pricing/currency";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orders = await prisma.order.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: {
      submission: { select: { id: true, title: true, status: true } },
    },
  });

  return NextResponse.json({ orders });
}

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

  const parsed = createOrderInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message, issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const { submissionId, zone, quantity, currency, shippingAddress } = parsed.data;
  const selectedCurrency = currency ?? DEFAULT_CURRENCY;

  const submission = await prisma.submission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      userId: true,
      status: true,
      pdfS3Key: true,
    },
  });

  if (!submission) {
    return NextResponse.json({ error: "Submission not found" }, { status: 404 });
  }
  if (submission.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (submission.status !== SubmissionStatus.APPROVED) {
    return NextResponse.json(
      { error: "Only approved Titchybooks can be ordered" },
      { status: 400 }
    );
  }
  if (!submission.pdfS3Key) {
    return NextResponse.json(
      { error: "PDF is not yet ready for this Titchybook" },
      { status: 400 }
    );
  }

  const cfg = await loadPricingConfig();

  if (!cfg.enabledZones.includes(zone)) {
    return NextResponse.json(
      { error: `Shipping to ${zone} is currently disabled` },
      { status: 400 }
    );
  }

  let calc;
  try {
    calc = calculateOrder(zone, quantity, cfg);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Calculation failed",
      },
      { status: 400 }
    );
  }

  const order = await prisma.order.create({
    data: {
      userId: session.user.id,
      submissionId: submission.id,
      quantity: calc.quantity,
      zone: calc.zone,
      weightGrams: calc.weightGrams,
      shippingBand: calc.shippingBand,
      unitPriceHuf: calc.unitPriceHuf,
      printCostHuf: calc.printCostHuf,
      handlingCostHuf: calc.handlingCostHuf,
      shippingCostHuf: calc.shippingCostHuf,
      discountHuf: calc.discountHuf,
      totalHuf: calc.totalHuf,
      currency: selectedCurrency,
      status: "PENDING_PAYMENT",
      pricingConfigVersion: cfg.version,
      recipientName: shippingAddress.recipientName,
      line1: shippingAddress.line1,
      line2: shippingAddress.line2,
      city: shippingAddress.city,
      postalCode: shippingAddress.postalCode,
      countryCode: shippingAddress.countryCode,
      phone: shippingAddress.phone,
    },
  });

  return NextResponse.json({ order }, { status: 201 });
}
