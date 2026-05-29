const items = [
    {
        n: "01",
        t: "8-page A7 booklet",
        d: "Four folded panels. Front cover, back cover, six inside pages.",
    },
    {
        n: "02",
        t: "Designed digitally",
        d: "A Canva-style drag-and-drop editor built for the A7 format.",
    },
    {
        n: "03",
        t: "Printed as PDF or by us",
        d: "Export a ready-to-print PDF, or order a professional print run.",
    },
    {
        n: "04",
        t: "Carried in pockets",
        d: "Small enough to live in a jacket, bag, or back pocket.",
    },
    {
        n: "05",
        t: "Marketing or publication",
        d: "A cafe token card, a pocket zine, a portfolio, a manifesto.",
    },
];

export default function WhatItIs() {
    return (
        <section
            style={{
                background: "var(--color-surface)",
                borderBottom: "1px solid var(--color-border)",
            }}
        >
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p className="section-label mb-4">What it is</p>
                <h2
                    className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl leading-tight"
                    style={{ color: "var(--color-text)" }}
                >
                    A physical object. Designed digitally. Circulated by hand.
                </h2>
                <div className="mt-14 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-10">
                    {items.map((i) => (
                        <div key={i.n}>
                            <div
                                className="text-xs font-mono mb-3"
                                style={{ color: "var(--color-text-subtle)" }}
                            >
                                {i.n}
                            </div>
                            <div
                                className="font-medium mb-1.5"
                                style={{ color: "var(--color-text)" }}
                            >
                                {i.t}
                            </div>
                            <p
                                className="text-sm leading-relaxed"
                                style={{ color: "var(--color-text-muted)" }}
                            >
                                {i.d}
                            </p>
                        </div>
                    ))}
                </div>
                <p
                    className="mt-16 text-xl md:text-2xl max-w-2xl italic"
                    style={{
                        color: "var(--color-text)",
                        borderLeft: "2px solid var(--color-primary)",
                        paddingLeft: "1.5rem",
                    }}
                >
                    These are designed to be kept, not discarded.
                </p>
            </div>
        </section>
    );
}
