import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolvePaymentAlert } from "@/lib/orders/payment-alerts";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/payment-alerts/[id] - dismiss one reconciliation alert.
 *
 * Dismissing records that an operator has dealt with the condition; it does not
 * change the order. If the same condition recurs the alert reopens with an
 * incremented occurrence count, so a dismissal is never permanent suppression.
 */
export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const resolved = await resolvePaymentAlert(id);
  if (!resolved) {
    return NextResponse.json(
      { error: "Alert not found or already resolved" },
      { status: 404 }
    );
  }

  return NextResponse.json({ resolved: true });
}
