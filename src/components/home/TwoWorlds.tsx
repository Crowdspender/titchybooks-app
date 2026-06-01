import Link from "next/link";

const business = [
    "Replace flyers with keepable booklets",
    "Attach real-world perks — coffee, cakes, offers",
    "Create circulating physical marketing",
    "Funded promotions via the Outernet system",
    "Example: buy coffee → receive free cake via Titchybooks token",
];

const creator = [
    "Pocket zines, stories, portfolios, ideas",
    "Hand-to-hand physical sharing",
    "Leave-behind creative works in cafes and spaces",
    "Versioned publishing — Edition 1, 2, 3",
    "Designed for expression, not algorithms",
];

export default function TwoWorlds() {
    return (
        <section
            style={{
                background: "var(--color-background)",
                borderBottom: "1px solid var(--color-border)",
            }}
        >
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p className="section-label mb-4">Two worlds, one format</p>
                <h2
                    className="text-3xl md:text-5xl font-semibold tracking-tight mb-14 leading-tight"
                    style={{ color: "var(--color-text)" }}
                >
                    Built equally for businesses
                    <br />
                    and creators.
                </h2>
                <div className="grid md:grid-cols-2 gap-6">
                    {/* Business card */}
                    <div
                        className="rounded-xl p-8 md:p-10 flex flex-col transition-transform hover:-translate-y-1"
                        style={{
                            background: "var(--color-primary)",
                            color: "var(--color-text-inverse)",
                            boxShadow: "0 8px 32px -8px rgba(180, 70, 43, 0.3)",
                        }}
                    >
                        <div className="text-xs uppercase tracking-[0.2em] opacity-70 mb-4">
                            Outernet Commerce · For Businesses
                        </div>
                        <h3 className="text-2xl md:text-3xl font-semibold leading-tight mb-8">
                            Turn your cafe, shop, or local brand into something
                            people carry.
                        </h3>
                        <ul className="space-y-3 text-[15px] leading-relaxed flex-1">
                            {business.map((b) => (
                                <li key={b} className="flex gap-3">
                                    <span className="opacity-60 shrink-0">
                                        —
                                    </span>
                                    <span>{b}</span>
                                </li>
                            ))}
                        </ul>
                        <Link
                            href="/register?audience=business"
                            className="mt-10 inline-flex w-fit items-center gap-2 px-5 py-3 rounded-lg font-medium hover:bg-white/90 transition-colors"
                            style={{
                                background: "var(--color-surface)",
                                color: "var(--color-text)",
                            }}
                        >
                            Create a Business Titchybooks →
                        </Link>
                    </div>

                    {/* Creator card */}
                    <div
                        className="rounded-xl p-8 md:p-10 flex flex-col transition-transform hover:-translate-y-1"
                        style={{
                            background: "var(--color-secondary)",
                            color: "var(--color-text-inverse)",
                            boxShadow: "0 8px 32px -8px rgba(31, 58, 95, 0.3)",
                        }}
                    >
                        <div className="text-xs uppercase tracking-[0.2em] opacity-70 mb-4">
                            Outernet Publishing · For Creators
                        </div>
                        <h3 className="text-2xl md:text-3xl font-semibold leading-tight mb-8">
                            Publish something small enough to carry, real enough
                            to matter.
                        </h3>
                        <ul className="space-y-3 text-[15px] leading-relaxed flex-1">
                            {creator.map((c) => (
                                <li key={c} className="flex gap-3">
                                    <span className="opacity-60 shrink-0">
                                        —
                                    </span>
                                    <span>{c}</span>
                                </li>
                            ))}
                        </ul>
                        <Link
                            href="/create"
                            className="mt-10 inline-flex w-fit items-center gap-2 px-5 py-3 rounded-lg font-medium hover:bg-white/90 transition-colors"
                            style={{
                                background: "var(--color-surface)",
                                color: "var(--color-text)",
                            }}
                        >
                            Create a Personal Titchybooks →
                        </Link>
                    </div>
                </div>
            </div>
        </section>
    );
}
