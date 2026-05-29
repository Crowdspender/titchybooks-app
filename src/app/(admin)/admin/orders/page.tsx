import OrderModeration from "@/components/admin/OrderModeration";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function AdminOrdersPage() {
    const session = await auth();
    if (!session?.user || session.user.role !== "ADMIN") {
        redirect("/dashboard");
    }

    return (
        <>
            <div
                className="page-container pt-6 flex gap-1 text-sm"
                style={{ borderBottom: "1px solid var(--color-border)" }}
            >
                <Link
                    href="/admin"
                    className="px-4 py-2.5 font-medium no-underline hover:text-stone-900 transition-colors"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Submissions
                </Link>
                <span
                    className="px-4 py-2.5 font-medium"
                    style={{
                        color: "var(--color-primary)",
                        borderBottom: "2px solid var(--color-primary)",
                    }}
                >
                    Orders
                </span>
                <Link
                    href="/admin/pricing"
                    className="px-4 py-2.5 font-medium no-underline hover:text-stone-900 transition-colors"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Pricing
                </Link>
            </div>
            <OrderModeration />
        </>
    );
}
