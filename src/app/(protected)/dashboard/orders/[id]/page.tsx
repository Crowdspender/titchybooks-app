import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isStripeConfigured } from "@/lib/stripe";
import PayNowButton from "@/components/orders/PayNowButton";
import PaymentStatus, {
    paymentMessage,
} from "@/components/orders/PaymentStatus";
import { type Zone, ZONE_LABELS } from "@/lib/pricing/constants";
import { formatCharge, isCurrency } from "@/lib/pricing/currency";

export default async function OrderDetailPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ checkout?: string }>;
}) {
    const session = await auth();
    if (!session?.user?.id) {
        redirect("/login");
    }

    const { id } = await params;
    const { checkout } = await searchParams;
    const order = await prisma.order.findUnique({
        where: { id },
        include: {
            submission: { select: { id: true, title: true, status: true } },
        },
    });

    if (!order) notFound();
    if (order.userId !== session.user.id) {
        const currentRole = session.user.role === "ADMIN"
            ? (await prisma.user.findUnique({
                where: { id: session.user.id },
                select: { role: true },
            }))?.role
            : null;
        if (currentRole !== "ADMIN") redirect("/dashboard/orders");
    }

    const fmt = (v: number) => `${v.toLocaleString("en-US")} HUF`;
    const charge =
        order.expectedMinorAmount !== null && isCurrency(order.currency)
            ? formatCharge(order.expectedMinorAmount, order.currency)
            : null;
    const snapshot = order.quoteSnapshot as {
        terms?: { version?: string; text?: string };
        shipping?: { destination?: { service?: string } };
    } | null;

    // A return URL is not payment evidence; persisted reconciliation is authoritative.
    const canPay = order.status === "PENDING_PAYMENT" && !order.paymentHold &&
        (order.paymentState === null ||
            ["UNPAID", "FAILED"].includes(order.paymentState));
    const banner = checkout === "success" || checkout === "canceled"
        ? {
            text: `${
                checkout === "success"
                    ? "Returned from checkout."
                    : "Checkout was closed. Closing checkout is not a refund."
            } ${paymentMessage(order.paymentState, order.paymentHold)}`,
            color: "var(--color-text)",
            bg: "var(--color-accent-light)",
        }
        : null;

    return (
        <div className="page-container py-10">
            {banner && (
                <div
                    className="mb-6 rounded-xl px-4 py-3 text-sm font-medium"
                    style={{ color: banner.color, background: banner.bg }}
                    role="status"
                >
                    {banner.text}
                </div>
            )}
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
                <div className="flex items-center gap-3">
                    {canPay && isStripeConfigured() && (
                        <PayNowButton orderId={order.id} />
                    )}
                    <Link
                        href="/dashboard/orders"
                        className="btn btn-ghost btn-sm"
                    >
                        ← All orders
                    </Link>
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <DetailCard title="Summary">
                    <DetailRow
                        label="Status"
                        value={order.status.replace("_", " ")}
                    />
                    <DetailRow
                        label="Titchybooks"
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

                <DetailCard title="Payment">
                    <PaymentStatus
                        state={order.paymentState}
                        hold={order.paymentHold}
                        summary={order.paymentSummary}
                    />
                    <p
                        className="text-xs"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        Payment status is separate from printing, delivery, and
                        physical Vault receipt.
                    </p>
                    <form method="get">
                        <button className="btn btn-ghost btn-sm">
                            Refresh payment status
                        </button>
                    </form>
                    {(order.paymentHold || order.paymentState === "REVIEW") && (
                        <Link
                            href="/contact?topic=other"
                            className="btn btn-ghost btn-sm"
                        >
                            Request payment review
                        </Link>
                    )}
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
                    {order.vaultFeeHuf > 0 && (
                        <DetailRow
                            label="Vault storage (2 copies)"
                            value={fmt(order.vaultFeeHuf)}
                        />
                    )}
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
                        label="HUF total"
                        value={fmt(order.totalHuf)}
                        emphasis
                    />
                    {charge
                        ? (
                            <>
                                <DetailRow
                                    label={order.quoteAcceptedAt
                                        ? "Accepted charge"
                                        : "Recovered original charge"}
                                    value={charge}
                                    emphasis
                                />
                                <p
                                    className="text-xs"
                                    style={{ color: "var(--color-text-muted)" }}
                                >
                                    Payment retries retain this exact charge;
                                    current exchange rates do not reprice it.
                                </p>
                                <DetailRow
                                    label="Original FX (per HUF)"
                                    value={order.fxRate?.toString() ??
                                        "Unknown — not reconstructed"}
                                />
                                {order.quoteAcceptedAt && (
                                    <DetailRow
                                        label="Quote accepted"
                                        value={order.quoteAcceptedAt
                                            .toLocaleString()}
                                    />
                                )}
                                {order.pricingConfigVersion !== null && (
                                    <DetailRow
                                        label="Tariff version"
                                        value={String(
                                            order.pricingConfigVersion,
                                        )}
                                    />
                                )}
                            </>
                        )
                        : (
                            <p
                                className="text-xs"
                                style={{ color: "var(--color-text-muted)" }}
                            >
                                Legacy order: the original charge is not yet
                                proven. No amount is inferred from current
                                exchange rates; contact us before retrying
                                payment.
                            </p>
                        )}
                    {typeof snapshot?.shipping?.destination?.service ===
                            "string" && (
                        <DetailRow
                            label="Accepted service"
                            value={snapshot.shipping.destination.service}
                        />
                    )}
                    {typeof snapshot?.terms?.text === "string" && (
                        <details className="text-xs pt-2">
                            <summary className="cursor-pointer">
                                Accepted terms ({snapshot.terms.version})
                            </summary>
                            <p className="mt-2 whitespace-pre-wrap break-words">
                                {snapshot.terms.text}
                            </p>
                        </details>
                    )}
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
