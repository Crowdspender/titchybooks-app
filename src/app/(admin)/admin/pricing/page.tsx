import PricingConfigForm from "@/components/admin/PricingConfigForm";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import Link from "next/link";

export default async function AdminPricingPage() {
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
                <Link
                    href="/admin/orders"
                    className="px-4 py-2.5 font-medium no-underline hover:text-stone-900 transition-colors"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Orders
                </Link>
                <span
                    className="px-4 py-2.5 font-medium"
                    style={{
                        color: "var(--color-primary)",
                        borderBottom: "2px solid var(--color-primary)",
                    }}
                >
                    Pricing
                </span>
            </div>
            <PricingConfigForm />
        </>
    );
}
