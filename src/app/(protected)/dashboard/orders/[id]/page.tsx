import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { type Zone, ZONE_LABELS } from "@/lib/pricing/constants";

export default async function OrderDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) {
        redirect("/login");
    }

    const { id } = await params;
    const order = await prisma.order.findUnique({
        where: { id },
        include: {
            submission: { select: { id: true, title: true, status: true } },
        },
    });

    if (!order) notFound();
    if (order.userId !== session.user.id && session.user.role !== "ADMIN") {
        redirect("/dashboard/orders");
    }

    const fmt = (v: number) => `${v.toLocaleString("en-US")} HUF`;

    return (
        <div className="page-container py-10">
            {/* Header */}
            <div className="mb-8 flex items-start justify-between">
                <div>
                    <p className="section-label mb-2">Order details</p>
                    <h1
                        className="text-3xl font-semibold tracking-tight"
                        style={{ color: "var(--color-text)" }}
                    >
                        Order {order.id.slice(0, 8)}
                    </h1>
                </div>
                <Link
                    href="/dashboard/orders"
                    className="btn btn-ghost btn-sm"
                >
                    ← All orders
                </Link>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <DetailCard title="Summary">
                    <DetailRow
                        label="Status"
                        value={order.status.replace("_", " ")}
                    />
                    <DetailRow
                        label="Titchybook"
                        value={order.submission?.title || "—"}
                    />
                    <DetailRow
                        label="Quantity"
                        value={`${order.quantity} copies`}
                    />
                    <DetailRow
                        label="Destination"
                        value={ZONE_LABELS[order.zone as Zone] ?? order.zone}
                    />
                    <DetailRow
                        label="Weight"
                        value={`${order.weightGrams} g`}
                    />
                    <DetailRow
                        label="Created"
                        value={new Date(order.createdAt).toLocaleString()}
                    />
                </DetailCard>

                <DetailCard title="Pricing">
                    <DetailRow
                        label="Price per copy"
                        value={fmt(order.unitPriceHuf)}
                    />
                    <DetailRow
                        label="Print cost"
                        value={fmt(order.printCostHuf)}
                    />
                    {order.handlingCostHuf > 0 && (
                        <DetailRow
                            label="Handling"
                            value={fmt(order.handlingCostHuf)}
                        />
                    )}
                    <DetailRow
                        label="Shipping"
                        value={fmt(order.shippingCostHuf)}
                    />
                    {order.discountHuf > 0 && (
                        <DetailRow
                            label="Discount"
                            value={`-${fmt(order.discountHuf)}`}
                        />
                    )}
                    <div
                        className="my-3 h-px"
                        style={{ background: "var(--color-border)" }}
                    />
                    <DetailRow
                        label="Total"
                        value={fmt(order.totalHuf)}
                        emphasis
                    />
                </DetailCard>

                <DetailCard title="Shipping address" className="md:col-span-2">
                    <div className="space-y-1">
                        <p
                            className="text-sm font-medium"
                            style={{ color: "var(--color-text)" }}
                        >
                            {order.recipientName}
                        </p>
                        <p
                            className="text-sm"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            {order.line1}
                        </p>
                        {order.line2 && (
                            <p
                                className="text-sm"
                                style={{ color: "var(--color-text-muted)" }}
                            >
                                {order.line2}
                            </p>
                        )}
                        <p
                            className="text-sm"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            {order.postalCode} {order.city}, {order.countryCode}
                        </p>
                        {order.phone && (
                            <p
                                className="text-xs pt-1"
                                style={{ color: "var(--color-text-subtle)" }}
                            >
                                Phone: {order.phone}
                            </p>
                        )}
                    </div>
                </DetailCard>
            </div>
        </div>
    );
}

function DetailCard({
    title,
    children,
    className,
}: {
    title: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div className={`card p-6 ${className ?? ""}`}>
            <h2 className="section-label mb-4">{title}</h2>
            <div className="space-y-2.5">{children}</div>
        </div>
    );
}

function DetailRow({
    label,
    value,
    emphasis,
}: {
    label: string;
    value: string;
    emphasis?: boolean;
}) {
    return (
        <div className="flex items-center justify-between text-sm">
            <span style={{ color: "var(--color-text-muted)" }}>{label}</span>
            <span
                className={emphasis ? "text-base font-semibold" : "font-medium"}
                style={{ color: "var(--color-text)" }}
            >
                {value}
            </span>
        </div>
    );
}
