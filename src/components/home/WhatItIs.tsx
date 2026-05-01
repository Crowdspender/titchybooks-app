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
        <section className="border-b border-stone-200 bg-stone-50">
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p className="text-xs uppercase tracking-[0.2em] text-stone-500 mb-4">
                    What it is
                </p>
                <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-stone-900 max-w-3xl leading-tight">
                    A physical object. Designed digitally. Circulated by hand.
                </h2>
                <div className="mt-14 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-10">
                    {items.map((i) => (
                        <div key={i.n}>
                            <div className="text-xs font-mono text-stone-400 mb-3">
                                {i.n}
                            </div>
                            <div className="font-medium text-stone-900 mb-1.5">
                                {i.t}
                            </div>
                            <p className="text-sm text-stone-600 leading-relaxed">
                                {i.d}
                            </p>
                        </div>
                    ))}
                </div>
                <p className="mt-16 text-xl md:text-2xl text-stone-900 max-w-2xl border-l-2 border-stone-900 pl-6 italic">
                    These are designed to be kept, not discarded.
                </p>
            </div>
        </section>
    );
}
