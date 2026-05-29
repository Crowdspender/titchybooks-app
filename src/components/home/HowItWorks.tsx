const steps = [
    {
        n: "01",
        t: "Design",
        d: "Drag and drop across 8 A7 pages in the editor. Text, images, layouts — built for the pocket format.",
    },
    {
        n: "02",
        t: "Publish",
        d: "Export a print-ready PDF, or submit for approval and a professional print run.",
    },
    {
        n: "03",
        t: "Circulate",
        d: "Print, carry, share, leave behind, and redeem at participating cafes.",
    },
];

export default function HowItWorks() {
    return (
        <section
            style={{
                background: "var(--color-surface-dark)",
                color: "var(--color-text-inverse)",
                borderBottom: "1px solid rgba(255,255,255,0.08)",
            }}
        >
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p
                    className="text-xs font-semibold tracking-[0.18em] uppercase mb-4"
                    style={{ color: "rgba(250,250,247,0.5)" }}
                >
                    How it works
                </p>
                <h2 className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl leading-tight mb-16">
                    Three steps. Designed digitally, lived physically.
                </h2>
                <div className="grid md:grid-cols-3 gap-12">
                    {steps.map((s, i) => (
                        <div
                            key={s.n}
                            className="relative"
                            style={{
                                borderTop: "1px solid rgba(250,250,247,0.15)",
                                paddingTop: "1.5rem",
                            }}
                        >
                            <div
                                className="text-xs font-mono mb-4"
                                style={{ color: "rgba(250,250,247,0.4)" }}
                            >
                                {s.n}
                            </div>
                            <div className="text-2xl font-semibold mb-3">
                                {s.t}
                            </div>
                            <p
                                className="leading-relaxed"
                                style={{ color: "rgba(250,250,247,0.65)" }}
                            >
                                {s.d}
                            </p>
                            {i < steps.length - 1 && (
                                <div
                                    className="hidden md:block absolute top-8 -right-6 text-[1.25rem]"
                                    style={{ color: "rgba(250,250,247,0.2)" }}
                                >
                                    →
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
