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
            <div className="max-w-5xl mx-auto px-4 pt-6 flex gap-3 text-sm">
                <Link href="/admin" className="text-stone-600 hover:underline">
                    Submissions
                </Link>
                <Link
                    href="/admin/orders"
                    className="text-stone-600 hover:underline"
                >
                    Orders
                </Link>
                <span className="text-blue-600 font-medium">Pricing</span>
            </div>
            <PricingConfigForm />
        </>
    );
}
