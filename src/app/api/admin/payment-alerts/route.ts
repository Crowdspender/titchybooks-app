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
 * `olderThan` pages the newest-first event slice so no unresolved event is
 * unreachable when the queue exceeds one page. `olderThanId` breaks ties
 * between events sharing a createdAt (one transaction stamps them equally),
 * so a page boundary cannot skip a same-timestamp sibling.
 */
export async function GET(request?: Request) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN" ||
      (await prisma.user.findUnique({ where: { id: session.user.id }, select: { role: true } }))?.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const searchParams = request ? new URL(request.url).searchParams : null;
  const olderThan = searchParams?.get("olderThan") ?? null;
  const olderThanId = searchParams?.get("olderThanId") ?? null;
  let cursor: Date | undefined;
  if (olderThan !== null) {
    cursor = new Date(olderThan);
    if (Number.isNaN(cursor.getTime())) {
      return NextResponse.json({ error: "Invalid olderThan cursor" }, { status: 400 });
    }
  }
  if (olderThanId !== null && cursor === undefined) {
    return NextResponse.json({ error: "olderThanId requires olderThan" }, { status: 400 });
  }

  // Composite page boundary: strictly older, or same timestamp with a smaller
  // id (the secondary sort key). Without an id the legacy timestamp-only
  // cursor still applies.
  const pageWhere: Prisma.PaymentEventWhereInput | null = cursor === undefined ? null
    : olderThanId === null ? { createdAt: { lt: cursor } }
    : { OR: [{ createdAt: { lt: cursor } }, { createdAt: cursor, id: { lt: olderThanId } }] };
  const where: Prisma.PaymentEventWhereInput = { OR: [
    { status: { in: ['RECEIVED', 'FAILED', 'UNMATCHED'] } },
    { status: 'REVIEW', OR: [{ orderId: null }, { order: { paymentHold: true } }] },
  ], ...(pageWhere ? { AND: [pageWhere] } : {}) };
  const [alerts, events, eventCount] = await Promise.all([
    listOpenPaymentAlerts(),
    prisma.paymentEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100, select: {
      id: true, orderId: true, providerEventId: true, type: true, status: true, source: true,
      objectId: true, providerAccountId: true, livemode: true, outcome: true, createdAt: true,
    } }),
    prisma.paymentEvent.count({ where }),
  ]);
  return NextResponse.json({ alerts, events, eventCount }, { headers: { 'Cache-Control': 'private, no-store' } });
}
