import type { Metadata } from "next";
import Link from "next/link";

import ContactForm, {
    type ContactFormContext,
} from "@/components/contact/ContactForm";
import {
    isContactTopic,
    prefillContactMessage,
    SUPPORT_EMAIL,
    type ContactTopic,
} from "@/lib/contact";
import {
    DEFAULT_RESOLVED_CONFIG,
    ZONES,
    type ResolvedPricingConfig,
    type Zone,
    ZONE_LABELS,
} from "@/lib/pricing/constants";
import { formatKilograms } from "@/lib/pricing/engine";
import { loadPricingConfig } from "@/lib/pricing/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Contact Titchybooks — larger orders and unlisted destinations",
    description:
        "Order heavier than checkout allows, or shipping somewhere we do not list? Ask for a manual shipping quote.",
};

interface ContactPageProps {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function firstValue(
    params: Record<string, string | string[] | undefined>,
    key: string,
): string | undefined {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value?.trim() || undefined;
}

function toPositiveInt(value: string | undefined, max: number): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) return undefined;
    return parsed;
}

function toZone(value: string | undefined): Zone | undefined {
    return value && (ZONES as readonly string[]).includes(value)
        ? (value as Zone)
        : undefined;
}

/**
 * Live ceilings so the copy on this page matches whatever an admin has
 * configured. Falls back to the built-in defaults if the DB is unreachable —
 * the contact page must never be the thing that is down.
 */
async function destinationLimits(): Promise<
    { zone: Zone; label: string; maxGrams: number }[]
> {
    let config: ResolvedPricingConfig;
    try {
        config = await loadPricingConfig();
    } catch {
        config = DEFAULT_RESOLVED_CONFIG;
    }

    return config.enabledZones
        .map((zone) => {
            const ladder = config.shippingTable[zone] ?? [];
            const maxGrams = ladder.length
                ? ladder[ladder.length - 1].maxWeightGrams
                : 0;
            return { zone, label: ZONE_LABELS[zone], maxGrams };
        })
        .filter((entry) => entry.maxGrams > 0);
}

export default async function ContactPage({ searchParams }: ContactPageProps) {
    const params = await searchParams;

    const topicParam = firstValue(params, "topic");
    const topic: ContactTopic = isContactTopic(topicParam)
        ? topicParam
        : "other";
    const zone = toZone(firstValue(params, "zone"));
    const quantity = toPositiveInt(firstValue(params, "quantity"), 1_000_000);
    const weightGrams = toPositiveInt(firstValue(params, "weight"), 1_000_000);
    const reference = firstValue(params, "reference")?.slice(0, 120);

    const context: ContactFormContext = {
        zone,
        quantity,
        weightGrams,
        reference,
    };

    const limits = await destinationLimits();
    const initialMessage = prefillContactMessage({
        topic,
        zone,
        zoneLabel: zone ? ZONE_LABELS[zone] : undefined,
        quantity,
        weightGrams,
        reference,
    });

    return (
        <div className="page-container py-12">
            <header className="max-w-2xl">
                <p className="section-label mb-2">Contact</p>
                <h1
                    className="text-3xl md:text-4xl font-semibold tracking-tight"
                    style={{ color: "var(--color-text)" }}
                >
                    Bigger than checkout? Ask us.
                </h1>
                <p
                    className="mt-4 text-base"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Checkout prices a fixed set of destinations, each with one
                    carrier weight limit. Larger orders, other countries and
                    freight-sized runs are quoted by hand — every request is
                    answered by a person, usually within one business day.
                </p>
            </header>

            <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
                <ContactForm
                    initialTopic={topic}
                    initialMessage={initialMessage}
                    context={context}
                />

                <aside className="space-y-4">
                    <section className="card p-5">
                        <h2 className="section-label mb-3">
                            What checkout covers
                        </h2>
                        <ul className="space-y-2 text-sm">
                            {limits.map((entry) => (
                                <li
                                    key={entry.zone}
                                    className="flex items-start justify-between gap-3"
                                >
                                    <span
                                        style={{ color: "var(--color-text)" }}
                                    >
                                        {entry.label}
                                    </span>
                                    <span
                                        className="whitespace-nowrap text-xs"
                                        style={{
                                            color: "var(--color-text-muted)",
                                        }}
                                    >
                                        {entry.maxGrams <= 2000
                                            ? "small parcels only"
                                            : `up to ${formatKilograms(entry.maxGrams)}`}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        <p
                            className="mt-3 text-xs"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Heavier shipments and other countries are quoted
                            individually. 40 kg and above goes by commercial
                            courier.
                        </p>
                    </section>

                    <section className="card p-5">
                        <h2 className="section-label mb-3">Prefer email?</h2>
                        <p
                            className="text-sm"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Write to{" "}
                            <a
                                href={`mailto:${SUPPORT_EMAIL}`}
                                className="underline"
                                style={{ color: "var(--color-primary)" }}
                            >
                                {SUPPORT_EMAIL}
                            </a>{" "}
                            with the destination, copy count and deadline.
                        </p>
                        <p
                            className="mt-3 text-xs"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            Already have an order?{" "}
                            <Link
                                href="/dashboard/orders"
                                className="underline"
                                style={{ color: "var(--color-primary)" }}
                            >
                                Open it from your dashboard
                            </Link>{" "}
                            so the reference is attached automatically.
                        </p>
                    </section>
                </aside>
            </div>
        </div>
    );
}
