"use client";

import { useState } from "react";
import { toast } from "sonner";

/**
 * (Re)starts Stripe Checkout for a pending order via POST /api/orders/[id]/pay.
 * Rendered only when the deployment has Stripe configured.
 */
export default function PayNowButton({ orderId }: { orderId: string }) {
    const [busy, setBusy] = useState(false);

    async function payNow() {
        setBusy(true);
        try {
            const res = await fetch(`/api/orders/${orderId}/pay`, {
                method: "POST",
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || "Could not start payment");
            }
            if (!data.checkoutUrl) {
                throw new Error("Payment is not available for this order");
            }
            window.location.assign(data.checkoutUrl as string);
            // Keep the button disabled while the browser navigates away.
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : "Payment failed",
            );
            setBusy(false);
        }
    }

    return (
        <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={payNow}
            disabled={busy}
        >
            {busy ? "Redirecting…" : "Pay now"}
        </button>
    );
}
