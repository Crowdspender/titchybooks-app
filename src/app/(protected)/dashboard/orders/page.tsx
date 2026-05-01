import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const STATUS_STYLES: Record<string, string> = {
    PENDING_PAYMENT: "bg-amber-100 text-amber-800",
    PAID: "bg-blue-100 text-blue-800",
    IN_PRODUCTION: "bg-indigo-100 text-indigo-800",
    SHIPPED: "bg-violet-100 text-violet-800",
    DELIVERED: "bg-emerald-100 text-emerald-800",
    CANCELLED: "bg-stone-200 text-stone-700",
};

export default async function OrdersListPage() {
    const session = await auth();
    if (!session?.user?.id) {
        redirect("/login");
    }

    const orders = await prisma.order.findMany({
        where: { userId: session.user.id },
        orderBy: { createdAt: "desc" },
        include: {
            submission: { select: { id: true, title: true } },
        },
    });

    return (
        <div className="max-w-3xl mx-auto px-4 py-8">
            <div className="mb-6 flex items-center justify-between">
                <h1 className="text-2xl font-bold">My Orders</h1>
                <Link
                    href="/dashboard"
                    className="text-sm text-stone-600 hover:underline"
                >
                    Back to dashboard
                </Link>
            </div>

            {orders.length === 0
                ? (
                    <div className="rounded-lg border border-stone-200 p-8 text-center text-stone-500">
                        <p className="mb-4">
                            You haven&apos;t ordered any prints yet.
                        </p>
                        <Link
                            href="/dashboard"
                            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                        >
                            See approved Titchybooks
                        </Link>
                    </div>
                )
                : (
                    <div className="space-y-3">
                        {orders.map((order) => (
                            <Link
                                key={order.id}
                                href={`/dashboard/orders/${order.id}`}
                                className="block rounded-lg border border-stone-200 p-4 transition hover:border-stone-300 hover:bg-stone-50"
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate font-medium">
                                            {order.submission?.title ||
                                                "Titchybook"}
                                        </p>
                                        <p className="text-xs text-stone-500">
                                            {order.quantity} copies ·{" "}
                                            {order.zone} ·{" "}
                                            {new Date(order.createdAt)
                                                .toLocaleDateString()}
                                        </p>
                                    </div>
                                    <div className="flex flex-col items-end gap-1">
                                        <span
                                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                                STATUS_STYLES[order.status] ??
                                                    "bg-stone-100 text-stone-700"
                                            }`}
                                        >
                                            {order.status.replace("_", " ")}
                                        </span>
                                        <span className="text-sm font-semibold">
                                            {order.totalHuf.toLocaleString(
                                                "en-US",
                                            )} HUF
                                        </span>
                                    </div>
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
        </div>
    );
}
