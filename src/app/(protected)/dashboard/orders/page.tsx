import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
    PENDING_PAYMENT: { bg: "var(--color-accent-light)", color: "#92400E" },
    PAID: { bg: "var(--color-info-light)", color: "#1E40AF" },
    IN_PRODUCTION: { bg: "#EDE9FE", color: "#5B21B6" },
    SHIPPED: { bg: "#F3E8FF", color: "#6B21A8" },
    DELIVERED: { bg: "var(--color-success-light)", color: "#065F46" },
    CANCELLED: { bg: "var(--color-border)", color: "var(--color-text-muted)" },
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
        <div className="page-container py-10">
            {/* Page header */}
            <div className="mb-8 flex items-start justify-between">
                <div>
                    <p className="section-label mb-2">Print runs</p>
                    <h1
                        className="text-3xl font-semibold tracking-tight"
                        style={{ color: "var(--color-text)" }}
                    >
                        My Orders
                    </h1>
                </div>
                <Link
                    href="/dashboard"
                    className="btn btn-ghost btn-sm"
                >
                    ← Back to dashboard
                </Link>
            </div>

            {orders.length === 0
                ? (
                    <div
                        className="card p-12 text-center"
                        style={{ borderColor: "var(--color-border)" }}
                    >
                        <p
                            className="font-medium mb-1"
                            style={{ color: "var(--color-text)" }}
                        >
                            No orders yet
                        </p>
                        <p
                            className="text-sm mb-6"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Submit an approved Titchybook for printing to see
                            your orders here.
                        </p>
                        <Link href="/dashboard" className="btn btn-primary">
                            See approved Titchybooks
                        </Link>
                    </div>
                )
                : (
                    <div className="space-y-3">
                        {orders.map((order) => {
                            const statusStyle = STATUS_STYLES[order.status] ?? {
                                bg: "var(--color-border)",
                                color: "var(--color-text-muted)",
                            };
                            return (
                                <Link
                                    key={order.id}
                                    href={`/dashboard/orders/${order.id}`}
                                    className="card card-hover p-5 flex items-center justify-between gap-4 no-underline"
                                    style={{ display: "flex" }}
                                >
                                    <div className="min-w-0 flex-1">
                                        <p
                                            className="truncate font-semibold text-[0.9375rem]"
                                            style={{
                                                color: "var(--color-text)",
                                            }}
                                        >
                                            {order.submission?.title ||
                                                "Titchybook"}
                                        </p>
                                        <p
                                            className="text-xs mt-0.5"
                                            style={{
                                                color:
                                                    "var(--color-text-subtle)",
                                            }}
                                        >
                                            {order.quantity} copies ·{" "}
                                            {order.zone} ·{" "}
                                            {new Date(order.createdAt)
                                                .toLocaleDateString("en-US", {
                                                    month: "short",
                                                    day: "numeric",
                                                    year: "numeric",
                                                })}
                                        </p>
                                    </div>
                                    <div className="flex flex-col items-end gap-1.5">
                                        <span
                                            className="badge"
                                            style={{
                                                background: statusStyle.bg,
                                                color: statusStyle.color,
                                            }}
                                        >
                                            {order.status.replace("_", " ")}
                                        </span>
                                        <span
                                            className="text-sm font-semibold"
                                            style={{
                                                color: "var(--color-text)",
                                            }}
                                        >
                                            {order.totalHuf.toLocaleString(
                                                "en-US",
                                            )} HUF
                                        </span>
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                )}
        </div>
    );
}
