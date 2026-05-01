export default function Examples() {
    return (
        <section className="border-b border-stone-200 bg-stone-100">
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p className="text-xs uppercase tracking-[0.2em] text-stone-500 mb-4">
                    In the wild
                </p>
                <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-stone-900 max-w-3xl leading-tight mb-14">
                    Two examples, same A7 format.
                </h2>
                <div className="grid md:grid-cols-2 gap-10">
                    <article className="bg-stone-50 p-8 md:p-10 rounded-sm border border-stone-200">
                        <div className="flex items-start justify-between gap-6 mb-8">
                            <div>
                                <div className="text-xs uppercase tracking-[0.2em] text-[#B4462B] mb-3">
                                    Business example
                                </div>
                                <h3 className="text-2xl font-semibold text-stone-900 leading-tight">
                                    Corner Cafe — Cake Token Edition
                                </h3>
                            </div>
                            <div className="w-[74px] h-[105px] shrink-0 bg-[#B4462B] rounded-sm text-stone-50 p-2 flex flex-col justify-between text-[9px] shadow-md">
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
                        <ul className="text-sm text-stone-700 space-y-2 leading-relaxed">
                            <li>
                                — Cafe story printed across the front panels
                            </li>
                            <li>— Cake tokens printed on the back cover</li>
                            <li>— Redemption system tracked at the counter</li>
                            <li>— Customers carry, use, and pass it on</li>
                        </ul>
                    </article>

                    <article className="bg-stone-50 p-8 md:p-10 rounded-sm border border-stone-200">
                        <div className="flex items-start justify-between gap-6 mb-8">
                            <div>
                                <div className="text-xs uppercase tracking-[0.2em] text-[#1F3A5F] mb-3">
                                    Creator example
                                </div>
                                <h3 className="text-2xl font-semibold text-stone-900 leading-tight">
                                    Midnight Routes — 8-page travel zine
                                </h3>
                            </div>
                            <div className="w-[74px] h-[105px] shrink-0 bg-[#1F3A5F] rounded-sm text-stone-50 p-2 flex flex-col justify-between text-[9px] shadow-md">
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
                        <ul className="text-sm text-stone-700 space-y-2 leading-relaxed">
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
