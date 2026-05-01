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
            <div className="max-w-6xl mx-auto px-4 pt-6 flex gap-3 text-sm">
                <Link href="/admin" className="text-stone-600 hover:underline">
                    Submissions
                </Link>
                <span className="text-blue-600 font-medium">Orders</span>
                <Link
                    href="/admin/pricing"
                    className="text-stone-600 hover:underline"
                >
                    Pricing
                </Link>
            </div>
            <OrderModeration />
        </>
    );
}
