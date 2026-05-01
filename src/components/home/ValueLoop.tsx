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
        <section className="border-b border-stone-200 bg-stone-50">
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p className="text-xs uppercase tracking-[0.2em] text-stone-500 mb-4">
                    Physical value loop
                </p>
                <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-stone-900 max-w-3xl leading-tight">
                    Print becomes a circulating social object.
                </h2>
                <div className="mt-14 grid grid-cols-1 md:grid-cols-4 gap-8">
                    {nodes.map((n, i) => (
                        <div key={n.t} className="relative">
                            <div className="text-xs font-mono text-stone-400 mb-3">
                                {String(i + 1).padStart(2, "0")}{" "}
                                {i < nodes.length - 1 ? "→" : "↻"}
                            </div>
                            <div className="font-medium text-stone-900 mb-2 text-lg">
                                {n.t}
                            </div>
                            <p className="text-sm text-stone-600 leading-relaxed">
                                {n.d}
                            </p>
                        </div>
                    ))}
                </div>
                <p className="mt-16 text-2xl md:text-3xl font-semibold text-stone-900 max-w-3xl leading-tight">
                    &ldquo;Titchybooks turn print into a circulating social
                    object.&rdquo;
                </p>
            </div>
        </section>
    );
}
