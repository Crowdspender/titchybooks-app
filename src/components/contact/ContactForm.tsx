"use client";

import { useState } from "react";
import Link from "next/link";

import {
    CONTACT_TOPICS,
    contactMailtoHref,
    contactTopicLabel,
    type ContactTopic,
    SUPPORT_EMAIL,
} from "@/lib/contact";
import { ZONE_LABELS, type Zone } from "@/lib/pricing/constants";
import { formatKilograms } from "@/lib/pricing/engine";

export interface ContactFormContext {
    zone?: Zone;
    quantity?: number;
    weightGrams?: number;
    reference?: string;
}

interface ContactFormProps {
    initialTopic: ContactTopic;
    initialMessage: string;
    context?: ContactFormContext;
}

export default function ContactForm({
    initialTopic,
    initialMessage,
    context,
}: ContactFormProps) {
    const [name, setName] = useState("");
    const [email, setEmail] = useState("");
    const [topic, setTopic] = useState<ContactTopic>(initialTopic);
    const [message, setMessage] = useState(initialMessage);
    const [submitting, setSubmitting] = useState(false);
    const [sent, setSent] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mailtoHref, setMailtoHref] = useState<string | null>(null);

    const facts: string[] = [];
    if (context?.zone) facts.push(`Destination: ${ZONE_LABELS[context.zone]}`);
    if (context?.quantity && context.quantity > 0) {
        facts.push(`Copies: ${context.quantity.toLocaleString("en-GB")}`);
    }
    if (context?.weightGrams && context.weightGrams > 0) {
        facts.push(`Weight: about ${formatKilograms(context.weightGrams)}`);
    }
    if (context?.reference) facts.push(`Reference: ${context.reference}`);

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError(null);
        setMailtoHref(null);
        setSubmitting(true);
        try {
            const res = await fetch("/api/contact", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name,
                    email,
                    topic,
                    message,
                    ...(context?.zone ? { zone: context.zone } : {}),
                    ...(context?.quantity
                        ? { quantity: context.quantity }
                        : {}),
                    ...(context?.weightGrams
                        ? { weightGrams: context.weightGrams }
                        : {}),
                    ...(context?.reference
                        ? { reference: context.reference }
                        : {}),
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setError(
                    data.error ??
                        "We could not send your message. Please try again.",
                );
                setMailtoHref(
                    contactMailtoHref({
                        topic,
                        message,
                        reference: context?.reference,
                    }),
                );
                return;
            }
            setSent(true);
        } catch {
            setError(
                "Network error while sending. Please try again, or email us directly.",
            );
            setMailtoHref(
                contactMailtoHref({
                    topic,
                    message,
                    reference: context?.reference,
                }),
            );
        } finally {
            setSubmitting(false);
        }
    }

    if (sent) {
        return (
            <div className="card p-8">
                <p className="section-label mb-2">Message sent</p>
                <h2
                    className="text-2xl font-semibold"
                    style={{ color: "var(--color-text)" }}
                >
                    Thanks — we have your request.
                </h2>
                <p
                    className="mt-3 text-sm"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    We will reply to <strong>{email}</strong> within one
                    business day with a quote and the next steps. If your order
                    is urgent, mention it in the reply and we will prioritise
                    it.
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                    <Link href="/dashboard" className="btn btn-primary btn-sm">
                        Back to dashboard
                    </Link>
                    <button
                        type="button"
                        onClick={() => {
                            setSent(false);
                            setMessage(initialMessage);
                        }}
                        className="btn btn-outline btn-sm"
                    >
                        Send another message
                    </button>
                </div>
            </div>
        );
    }

    return (
        <form onSubmit={handleSubmit} className="card p-8">
            <div className="grid gap-4 sm:grid-cols-2">
                <div>
                    <label className="label" htmlFor="contact-name">
                        Your name
                    </label>
                    <input
                        id="contact-name"
                        className="input"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        autoComplete="name"
                        required
                        minLength={2}
                        maxLength={120}
                    />
                </div>
                <div>
                    <label className="label" htmlFor="contact-email">
                        Email address
                    </label>
                    <input
                        id="contact-email"
                        type="email"
                        className="input"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        autoComplete="email"
                        required
                    />
                </div>
            </div>

            <div className="mt-4">
                <label className="label" htmlFor="contact-topic">
                    What is this about?
                </label>
                <select
                    id="contact-topic"
                    className="input"
                    value={topic}
                    onChange={(event) =>
                        setTopic(event.target.value as ContactTopic)}
                >
                    {CONTACT_TOPICS.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                            {entry.label}
                        </option>
                    ))}
                </select>
                <p
                    className="mt-1 text-xs"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    {CONTACT_TOPICS.find((entry) => entry.value === topic)
                        ?.hint}
                </p>
            </div>

            {facts.length > 0 && (
                <div
                    className="mt-4 rounded-lg p-3 text-xs"
                    style={{
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-border)",
                        color: "var(--color-text-muted)",
                    }}
                >
                    <p className="font-medium" style={{ color: "var(--color-text)" }}>
                        Attached from your order
                    </p>
                    <ul className="mt-1 space-y-0.5">
                        {facts.map((fact) => (
                            <li key={fact}>{fact}</li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="mt-4">
                <label className="label" htmlFor="contact-message">
                    Message
                </label>
                <textarea
                    id="contact-message"
                    className="input"
                    rows={10}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    required
                    minLength={10}
                    maxLength={5000}
                    style={{ resize: "vertical", lineHeight: 1.6 }}
                />
                <p
                    className="mt-1 text-xs"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Tell us the country, the number of copies you need and any
                    deadline. We reply with a firm price and delivery estimate.
                </p>
            </div>

            {error && (
                <div
                    className="mt-4 rounded-lg px-3 py-2 text-sm"
                    style={{
                        background: "var(--color-error-light)",
                        color: "#991B1B",
                    }}
                >
                    <p>{error}</p>
                    {mailtoHref && (
                        <a
                            href={mailtoHref}
                            className="mt-1 inline-block underline"
                        >
                            Email {SUPPORT_EMAIL} instead
                        </a>
                    )}
                </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                    type="submit"
                    disabled={submitting}
                    className="btn btn-primary"
                >
                    {submitting ? "Sending..." : "Send request"}
                </button>
                <span
                    className="text-xs"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Or email{" "}
                    <a
                        href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
                            `[Titchybooks] ${contactTopicLabel(topic)}`,
                        )}`}
                        className="underline"
                        style={{ color: "var(--color-primary)" }}
                    >
                        {SUPPORT_EMAIL}
                    </a>
                </span>
            </div>
        </form>
    );
}
