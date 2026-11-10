import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { ORDER_STATUS_TRANSITIONS, type OrderStatus } from "@/lib/pricing/constants";
import { createVaultEntryForOrder } from "@/lib/orders/lifecycle";
import { recordPaymentAlert } from "@/lib/orders/payment-alerts";
import { adminUpdateOrderSchema } from "@/lib/pricing/schema";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      submission: { select: { id: true, title: true, status: true } },
      user: { select: { id: true, email: true, name: true } },
    },
  });

  if (!order) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ order });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = adminUpdateOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    );
  }

  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      submission: { select: { id: true, title: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  });
  if (!order) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Validate status transition (if a status change is requested).
  if (parsed.data.status && parsed.data.status !== order.status) {
    const allowed = ORDER_STATUS_TRANSITIONS[order.status as OrderStatus] ?? [];
    if (!allowed.includes(parsed.data.status)) {
      return NextResponse.json(
        {
          error: `Cannot transition from ${order.status} to ${parsed.data.status}`,
          allowed,
        },
        { status: 400 }
      );
    }
  }

  const updated = await prisma.order.update({
    where: { id },
    data: {
      status: parsed.data.status ?? undefined,
      // Mirror the webhook: stamp paidAt when manually flipping to PAID.
      paidAt:
        parsed.data.status === "PAID" && order.status !== "PAID"
          ? new Date()
          : undefined,
      notes: parsed.data.notes === undefined ? undefined : parsed.data.notes,
    },
  });

  // Shared side-effect with the Stripe webhook path: idempotently create
  // the vault entry when a paid order carries the vault add-on.
  let vaultEntryFailed = false;
  if (parsed.data.status === "PAID") {
    try {
      await createVaultEntryForOrder(prisma, order.id);
    } catch (error) {
      vaultEntryFailed = true;
      // Log error with context for recovery
      console.error(
        `[VaultEntry] Failed to create vault entry for order ${order.id}:`,
        error
      );
      // The buyer has paid and the vault copy they paid for is missing, so an
      // operator has to create it by hand. A log line is not a channel anyone
      // watches on serverless hosting: record it for the reconciliation banner
      // on /admin/orders and report it in this response.
      await recordPaymentAlert({
        kind: "vault-entry-failed",
        orderId: order.id,
        message: "Order marked PAID but the vault entry could not be created.",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  if (vaultEntryFailed) {
    return NextResponse.json({
      order: updated,
      warnings: [
        "Order is PAID but its vault entry could not be created - see the reconciliation banner.",
      ],
    });
  }

  return NextResponse.json({ order: updated });
}
