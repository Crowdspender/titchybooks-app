export default function Examples() {
    return (
        <section
            style={{
                background: "var(--color-background)",
                borderBottom: "1px solid var(--color-border)",
            }}
        >
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p className="section-label mb-4">In the wild</p>
                <h2
                    className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl leading-tight mb-14"
                    style={{ color: "var(--color-text)" }}
                >
                    Two examples, same A7 format.
                </h2>
                <div className="grid md:grid-cols-2 gap-6">
                    {/* Business example */}
                    <article
                        className="card card-hover p-8 md:p-10"
                        style={{ background: "var(--color-surface-raised)" }}
                    >
                        <div className="flex items-start justify-between gap-6 mb-8">
                            <div>
                                <div
                                    className="text-xs uppercase tracking-[0.2em] font-semibold mb-3"
                                    style={{ color: "var(--color-primary)" }}
                                >
                                    Business example
                                </div>
                                <h3
                                    className="text-2xl font-semibold leading-tight"
                                    style={{ color: "var(--color-text)" }}
                                >
                                    Corner Cafe — Cake Token Edition
                                </h3>
                            </div>
                            <div
                                className="w-[74px] h-[105px] shrink-0 rounded-lg p-2 flex flex-col justify-between text-[9px]"
                                style={{
                                    background: "var(--color-primary)",
                                    color: "var(--color-text-inverse)",
                                    boxShadow:
                                        "0 8px 24px -4px rgba(180, 70, 43, 0.3)",
                                }}
                            >
                                <span className="uppercase tracking-widest opacity-70">
                                    Corner
                                </span>
                                <span>
                                    Free cake
                                    <br />
                                    with coffee
                                </span>
                            </div>
                        </div>
                        <ul
                            className="text-sm space-y-2 leading-relaxed"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            <li>
                                — Cafe story printed across the front panels
                            </li>
                            <li>— Cake tokens printed on the back cover</li>
                            <li>— Redemption system tracked at the counter</li>
                            <li>— Customers carry, use, and pass it on</li>
                        </ul>
                    </article>

                    {/* Creator example */}
                    <article
                        className="card card-hover p-8 md:p-10"
                        style={{ background: "var(--color-surface-raised)" }}
                    >
                        <div className="flex items-start justify-between gap-6 mb-8">
                            <div>
                                <div
                                    className="text-xs uppercase tracking-[0.2em] font-semibold mb-3"
                                    style={{ color: "var(--color-secondary)" }}
                                >
                                    Creator example
                                </div>
                                <h3
                                    className="text-2xl font-semibold leading-tight"
                                    style={{ color: "var(--color-text)" }}
                                >
                                    Midnight Routes — 8-page travel zine
                                </h3>
                            </div>
                            <div
                                className="w-[74px] h-[105px] shrink-0 rounded-lg p-2 flex flex-col justify-between text-[9px]"
                                style={{
                                    background: "var(--color-secondary)",
                                    color: "var(--color-text-inverse)",
                                    boxShadow:
                                        "0 8px 24px -4px rgba(31, 58, 95, 0.3)",
                                }}
                            >
                                <span className="uppercase tracking-widest opacity-70">
                                    Ed. 03
                                </span>
                                <span>
                                    Midnight
                                    <br />
                                    Routes
                                </span>
                            </div>
                        </div>
                        <ul
                            className="text-sm space-y-2 leading-relaxed"
                            style={{ color: "var(--color-text-muted)" }}
                        >
                            <li>— Short story, manifesto, or travel notes</li>
                            <li>— Designed for handing to strangers</li>
                            <li>— Left behind on cafe tables</li>
                            <li>— Versioned as editions, not posts</li>
                        </ul>
                    </article>
                </div>
            </div>
        </section>
    );
}
