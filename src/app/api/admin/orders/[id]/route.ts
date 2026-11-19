import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { ORDER_STATUS_TRANSITIONS } from "@/lib/pricing/constants";
import { applyOrderLifecycle } from "@/lib/orders/lifecycle";
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

  try {
    const result = await prisma.$transaction(tx => applyOrderLifecycle(tx, id, {
      source: "admin", operatorId: session.user.id, update: parsed.data,
    }));
    if (!result.ok) {
      if (result.reason === "not-found") return NextResponse.json({ error: "Not found" }, { status: 404 });
      if (result.reason === "conflict") {
        return NextResponse.json({ error: "Order changed. Reload it before saving your edits." }, { status: 409 });
      }
      if (result.reason === "payment-review") {
        return NextResponse.json({ error: "Payment is on hold. Reconcile and explicitly review its current history before fulfillment.", code: "PAYMENT_REVIEW_REQUIRED" }, { status: 409 });
      }
      return NextResponse.json({
        error: `Cannot transition from ${result.status} to ${parsed.data.status}`,
        allowed: result.status ? ORDER_STATUS_TRANSITIONS[result.status] : [],
      }, { status: 400 });
    }
    return NextResponse.json({ order: result.order });
  } catch (error) {
    console.error("Order update transaction failed", error);
    // Vault failures roll back. A connection loss during commit can be
    // ambiguous: require a fresh read instead of claiming settlement succeeded.
    if (parsed.data.status === "PAID") {
      await recordPaymentAlert({
        kind: "vault-entry-failed", orderId: id,
        message: "Manual settlement could not be confirmed. Reload the order and review before retrying.",
        context: { operatorId: session.user.id, outcome: "unconfirmed" },
      });
    }
    return NextResponse.json({ error: "Update could not be confirmed. Reload the order and review before retrying." }, { status: 503 });
  }
}
