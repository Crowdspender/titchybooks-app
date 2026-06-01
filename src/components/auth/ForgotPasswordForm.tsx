"use client";

import { useState } from "react";
import { toast } from "sonner";

export default function ForgotPasswordForm() {
    const [email, setEmail] = useState("");
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setLoading(true);

        try {
            const res = await fetch("/api/auth/forgot-password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email }),
            });

            const data = await res.json();

            if (!res.ok) {
                toast.error(data.error || "Failed to send reset email");
                setLoading(false);
                return;
            }

            setSubmitted(true);
            setLoading(false);
            toast.success("Password reset link sent! Check your email.");
        } catch {
            toast.error("Something went wrong. Please try again.");
            setLoading(false);
        }
    }

    if (submitted) {
        return (
            <div className="space-y-5">
                <div
                    className="text-center p-4 rounded-lg"
                    style={{ background: "var(--color-success-light)" }}
                >
                    <svg
                        className="mx-auto mb-3"
                        width="48"
                        height="48"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--color-success)"
                        strokeWidth="2"
                    >
                        <circle cx="12" cy="12" r="10" />
                        <path d="M8 12l3 3 5-5" />
                    </svg>
                    <h3
                        className="text-lg font-semibold mb-1"
                        style={{ color: "var(--color-text)" }}
                    >
                        Check your email
                    </h3>
                    <p
                        className="text-sm"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        We&apos;ve sent a password reset link to{" "}
                        <strong>{email}</strong>
                    </p>
                </div>

                <div className="text-center">
                    <p
                        className="text-sm"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        Didn&apos;t receive the email? Check your spam folder or
                        {" "}
                        <button
                            onClick={() => setSubmitted(false)}
                            className="font-medium underline"
                            style={{ color: "var(--color-primary)" }}
                        >
                            try another email
                        </button>
                    </p>
                </div>
            </div>
        );
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-5">
            <div>
                <label htmlFor="email" className="label">Email</label>
                <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="input"
                    placeholder="you@example.com"
                />
                <p
                    className="mt-1.5 text-xs"
                    style={{ color: "var(--color-text-subtle)" }}
                >
                    Enter the email address associated with your account
                </p>
            </div>

            <button
                type="submit"
                disabled={loading}
                className="btn btn-primary w-full btn-lg"
            >
                {loading
                    ? (
                        <span className="flex items-center gap-2">
                            <svg
                                className="animate-spin"
                                width="16"
                                height="16"
                                viewBox="0 0 16 16"
                                fill="none"
                            >
                                <circle
                                    cx="8"
                                    cy="8"
                                    r="6"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeDasharray="30"
                                    strokeDashoffset="10"
                                />
                            </svg>
                            Sending reset link...
                        </span>
                    )
                    : (
                        "Send reset link"
                    )}
            </button>
        </form>
    );
}
