import Link from "next/link";

export default function FooterCTA() {
    return (
        <section
            style={{
                background:
                    "linear-gradient(175deg, var(--color-surface) 0%, var(--color-background) 100%)",
            }}
        >
            <div className="mx-auto max-w-6xl px-6 py-24 md:py-32">
                <h2
                    className="text-4xl md:text-6xl font-semibold tracking-tight max-w-3xl leading-[1.05]"
                    style={{ color: "var(--color-text)" }}
                >
                    Pick a side. Start a booklet.
                </h2>
                <p
                    className="mt-6 text-lg max-w-xl"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Titchybooks are not PDFs. They are physical objects that
                    circulate between people.
                </p>
                <div className="mt-10 grid sm:grid-cols-2 gap-4 max-w-2xl">
                    <Link
                        href="/register?audience=business"
                        className="flex flex-col justify-between p-7 rounded-xl no-underline min-h-[150px] transition-all hover:-translate-y-1 hover:shadow-xl"
                        style={{
                            background: "var(--color-primary)",
                            color: "var(--color-text-inverse)",
                            boxShadow: "0 8px 32px -8px rgba(39, 199, 249, 0.35)",
                        }}
                    >
                        <span className="text-xs uppercase tracking-[0.2em] opacity-70">
                            Outernet Commerce
                        </span>
                        <span className="text-xl font-medium">
                            For Businesses →
                        </span>
                    </Link>
                    <Link
                        href="/create"
                        className="flex flex-col justify-between p-7 rounded-xl no-underline min-h-[150px] transition-all hover:-translate-y-1 hover:shadow-xl"
                        style={{
                            background: "var(--color-secondary)",
                            color: "var(--color-text-inverse)",
                            boxShadow: "0 8px 32px -8px rgba(31, 58, 95, 0.3)",
                        }}
                    >
                        <span className="text-xs uppercase tracking-[0.2em] opacity-70">
                            Outernet Publishing
                        </span>
                        <span className="text-xl font-medium">
                            Create Titchybooks →
                        </span>
                    </Link>
                </div>

                {/* Footer bottom */}
                <div
                    className="mt-24 pt-8 flex flex-wrap items-center justify-between gap-4 text-xs"
                    style={{
                        borderTop: "1px solid var(--color-border)",
                        color: "var(--color-text-subtle)",
                    }}
                >
                    <span>
                        Titchybooks — Pocket publishing for the physical world.
                    </span>
                    <span>© {new Date().getFullYear()} Titchybooks</span>
                </div>
            </div>
        </section>
    );
}
