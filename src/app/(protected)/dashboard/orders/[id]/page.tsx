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
        <div className="max-w-3xl mx-auto px-4 py-8">
            <div className="mb-6 flex items-center justify-between">
                <h1 className="text-2xl font-bold">
                    Order {order.id.slice(0, 8)}
                </h1>
                <Link
                    href="/dashboard/orders"
                    className="text-sm text-stone-600 hover:underline"
                >
                    All orders
                </Link>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <Card title="Summary">
                    <Row
                        label="Status"
                        value={order.status.replace("_", " ")}
                    />
                    <Row
                        label="Titchybook"
                        value={order.submission?.title || "—"}
                    />
                    <Row label="Quantity" value={`${order.quantity} copies`} />
                    <Row
                        label="Destination"
                        value={ZONE_LABELS[order.zone as Zone] ?? order.zone}
                    />
                    <Row label="Weight" value={`${order.weightGrams} g`} />
                    <Row
                        label="Created"
                        value={new Date(order.createdAt).toLocaleString()}
                    />
                </Card>

                <Card title="Pricing">
                    <Row
                        label="Price per copy"
                        value={fmt(order.unitPriceHuf)}
                    />
                    <Row label="Print cost" value={fmt(order.printCostHuf)} />
                    {order.handlingCostHuf > 0 && (
                        <Row
                            label="Handling"
                            value={fmt(order.handlingCostHuf)}
                        />
                    )}
                    <Row label="Shipping" value={fmt(order.shippingCostHuf)} />
                    {order.discountHuf > 0 && (
                        <Row
                            label="Discount"
                            value={`-${fmt(order.discountHuf)}`}
                        />
                    )}
                    <div className="my-2 h-px bg-stone-200" />
                    <Row label="Total" value={fmt(order.totalHuf)} emphasis />
                </Card>

                <Card title="Shipping address" className="md:col-span-2">
                    <p className="text-sm">{order.recipientName}</p>
                    <p className="text-sm">{order.line1}</p>
                    {order.line2 && <p className="text-sm">{order.line2}</p>}
                    <p className="text-sm">
                        {order.postalCode} {order.city}, {order.countryCode}
                    </p>
                    {order.phone && (
                        <p className="text-xs text-stone-500">
                            Phone: {order.phone}
                        </p>
                    )}
                </Card>
            </div>
        </div>
    );
}

function Card({
    title,
    children,
    className,
}: {
    title: string;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={`rounded-lg border border-stone-200 bg-white p-5 ${
                className ?? ""
            }`}
        >
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-stone-500">
                {title}
            </h2>
            <div className="space-y-1.5">{children}</div>
        </div>
    );
}

function Row({
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
            <span className="text-stone-600">{label}</span>
            <span
                className={emphasis
                    ? "text-base font-semibold"
                    : "text-stone-800"}
            >
                {value}
            </span>
        </div>
    );
}
