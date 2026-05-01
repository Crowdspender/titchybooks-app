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
        <section className="border-b border-stone-800 bg-stone-900 text-stone-50">
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p className="text-xs uppercase tracking-[0.2em] text-stone-400 mb-4">
                    How it works
                </p>
                <h2 className="text-3xl md:text-5xl font-semibold tracking-tight max-w-3xl leading-tight mb-16">
                    Three steps. Designed digitally, lived physically.
                </h2>
                <div className="grid md:grid-cols-3 gap-12">
                    {steps.map((s) => (
                        <div
                            key={s.n}
                            className="border-t border-stone-700 pt-6"
                        >
                            <div className="text-xs font-mono text-stone-400 mb-4">
                                {s.n}
                            </div>
                            <div className="text-2xl font-semibold mb-3">
                                {s.t}
                            </div>
                            <p className="text-stone-300 leading-relaxed">
                                {s.d}
                            </p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
