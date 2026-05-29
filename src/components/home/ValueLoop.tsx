const nodes = [
    {
        t: "Businesses fund",
        d: "Cafes, shops, and brands fund real-world perks printed inside booklets.",
    },
    {
        t: "Creators distribute",
        d: "Writers, artists, and communities publish zines that carry those perks.",
    },
    {
        t: "Cafes hold and redeem",
        d: "Physical spaces become distribution points and redemption counters.",
    },
    {
        t: "People carry and share",
        d: "Readers carry booklets, use tokens, and pass them on socially.",
    },
];

export default function ValueLoop() {
    return (
        <section
            style={{
                background: "var(--color-surface)",
                borderBottom: "1px solid var(--color-border)",
            }}
        >
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p className="section-label mb-4">Physical value loop</p>
                <h2
                    className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl leading-tight"
                    style={{ color: "var(--color-text)" }}
                >
                    Print becomes a circulating social object.
                </h2>
                <div className="mt-14 grid grid-cols-1 md:grid-cols-4 gap-8">
                    {nodes.map((n, i) => (
                        <div key={n.t} className="relative">
                            <div
                                className="text-xs font-mono mb-3"
                                style={{ color: "var(--color-text-subtle)" }}
                            >
                                {String(i + 1).padStart(2, "0")}{" "}
                                {i < nodes.length - 1 ? "→" : "↻"}
                            </div>
                            <div
                                className="font-medium mb-2 text-lg"
                                style={{ color: "var(--color-text)" }}
                            >
                                {n.t}
                            </div>
                            <p
                                className="text-sm leading-relaxed"
                                style={{ color: "var(--color-text-muted)" }}
                            >
                                {n.d}
                            </p>
                        </div>
                    ))}
                </div>
                <p
                    className="mt-16 text-2xl md:text-3xl font-semibold max-w-3xl leading-tight"
                    style={{ color: "var(--color-text)" }}
                >
                    &ldquo;Titchybooks turn print into a circulating social
                    object.&rdquo;
                </p>
            </div>
        </section>
    );
}
