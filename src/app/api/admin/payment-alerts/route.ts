import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listOpenPaymentAlerts } from "@/lib/orders/payment-alerts";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/payment-alerts - open payment-reconciliation alerts.
 *
 * Retain historical alerts and expose unmatched/failed/held canonical events.
 * Dismissing an old alert never releases a payment or fulfillment hold.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN" ||
      (await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } }))?.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const where: Prisma.PaymentEventWhereInput = { OR: [
    { status: { in: ['RECEIVED', 'FAILED', 'UNMATCHED'] } },
    { status: 'REVIEW', OR: [{ orderId: null }, { order: { paymentHold: true } }] },
  ] };
  const [alerts, events, eventCount] = await Promise.all([
    listOpenPaymentAlerts(),
    prisma.paymentEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, select: {
      id: true, orderId: true, providerEventId: true, type: true, status: true, source: true,
      objectId: true, providerAccountId: true, livemode: true, outcome: true, createdAt: true,
    } }),
    prisma.paymentEvent.count({ where }),
  ]);
  return NextResponse.json({ alerts, events, eventCount }, { headers: { 'Cache-Control': 'private, no-store' } });
}
