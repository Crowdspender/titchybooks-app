import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listOpenPaymentAlerts } from "@/lib/orders/payment-alerts";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/payment-alerts - open payment-reconciliation alerts.
 *
 * These are the conditions the checkout webhook and the admin "mark PAID" path
 * deliberately survive without failing (see src/lib/orders/payment-alerts.ts).
 * They need a human decision, so they are listed on /admin/orders rather than
 * left in the log stream.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const alerts = await listOpenPaymentAlerts();
  return NextResponse.json({ alerts });
}
