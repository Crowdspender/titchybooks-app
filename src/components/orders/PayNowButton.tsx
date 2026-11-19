"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/**
 * (Re)starts Stripe Checkout for a pending order via POST /api/orders/[id]/pay.
 * Rendered only when the deployment has Stripe configured.
 */
export default function PayNowButton({ orderId }: { orderId: string }) {
    const [busy, setBusy] = useState(false);
    const [reviewRequired, setReviewRequired] = useState(false);
    const lock = useRef(false);
    const router = useRouter();
    const [confirmedState, setConfirmedState] = useState<string | null>(null);

    async function payNow() {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        try {
            const res = await fetch(`/api/orders/${orderId}/pay`, {
                method: "POST",
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (
                    data.code === "PAYMENT_REVIEW_REQUIRED" ||
                    data.code === "MANUAL_QUOTE_REQUIRED"
                ) setReviewRequired(true);
                throw new Error(data.error || "Could not start payment");
            }
            if (
                !data.checkoutUrl &&
                ["PAID", "MANUAL_PAID", "PROCESSING"].includes(
                    data.paymentState,
                )
            ) {
                setConfirmedState(data.paymentState);
                router.refresh();
                return;
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
            lock.current = false;
            setBusy(false);
        }
    }

    if (confirmedState) {
        return (
            <div className="text-sm" role="status">
                <p>
                    {confirmedState === "PROCESSING"
                        ? "Payment is processing. Do not pay again."
                        : confirmedState === "MANUAL_PAID"
                        ? "Manual payment recorded."
                        : "Payment confirmed."}
                </p>
                <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => router.refresh()}
                >
                    Refresh payment status
                </button>
            </div>
        );
    }
    if (reviewRequired) {
        return (
            <Link href="/contact?topic=other" className="btn btn-ghost btn-sm">
                Request payment review
            </Link>
        );
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
