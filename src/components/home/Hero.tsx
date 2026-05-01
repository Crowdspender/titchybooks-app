import Link from "next/link";

export default function Hero() {
    return (
        <section className="relative overflow-hidden border-b border-stone-200 bg-stone-50">
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28 grid md:grid-cols-2 gap-12 items-center">
                <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-stone-500 mb-6">
                        Outernet Publishing · Outernet Commerce
                    </p>
                    <h1 className="text-5xl md:text-7xl font-semibold tracking-tight text-stone-900 leading-[1.05]">
                        Small booklets that people keep, carry, and share.
                    </h1>
                    <p className="mt-6 text-lg text-stone-600 max-w-xl leading-relaxed">
                        Titchybooks are A7 printed micro-publications used by
                        businesses, creators, and communities to circulate ideas
                        in the physical world.
                    </p>
                    <div className="mt-10 flex flex-wrap gap-3">
                        <Link
                            href="/create"
                            className="inline-flex items-center justify-center px-6 py-3.5 bg-stone-900 text-stone-50 font-medium rounded-sm hover:bg-black transition"
                        >
                            Create a Titchybook
                        </Link>
                        <Link
                            href="/register?audience=business"
                            className="inline-flex items-center justify-center px-6 py-3.5 border border-stone-900 text-stone-900 font-medium rounded-sm hover:bg-stone-900 hover:text-stone-50 transition"
                        >
                            For Businesses
                        </Link>
                    </div>
                    <p className="mt-6 text-xs text-stone-500">
                        No credit card. Design, export PDF, or order a print
                        run.
                    </p>
                </div>

                <div className="relative h-[440px] flex items-center justify-center">
                    <div className="relative">
                        <div className="absolute -left-16 top-8 w-[148px] h-[210px] bg-stone-200 shadow-xl rotate-[-10deg] rounded-sm">
                            <div className="absolute bottom-3 left-3 text-[10px] text-stone-500 tracking-widest uppercase">
                                A7 · 74 × 105mm
                            </div>
                        </div>
                        <div className="absolute -right-14 top-4 w-[148px] h-[210px] bg-[#B4462B] shadow-xl rotate-[7deg] rounded-sm text-stone-50 p-3 flex flex-col justify-between">
                            <span className="text-[10px] uppercase tracking-widest opacity-70">
                                Cafe Edition
                            </span>
                            <div>
                                <div className="text-sm font-medium leading-tight">
                                    Free cake
                                    <br />
                                    with coffee
                                </div>
                                <div className="text-[9px] mt-2 opacity-70">
                                    redeem at counter
                                </div>
                            </div>
                        </div>
                        <div className="relative w-[148px] h-[210px] bg-stone-900 shadow-2xl rounded-sm text-stone-50 p-4 flex flex-col justify-between">
                            <span className="text-[10px] uppercase tracking-widest opacity-70">
                                Edition 01
                            </span>
                            <div>
                                <div className="text-xl font-semibold leading-tight">
                                    Titchy-
                                    <br />
                                    book
                                </div>
                                <div className="text-[10px] mt-2 opacity-70">
                                    pocket publishing
                                </div>
                            </div>
                        </div>
                    </div>
                    <p className="absolute bottom-0 left-0 right-0 text-center text-xs text-stone-500">
                        Shown at actual size. Fits in a jacket pocket.
                    </p>
                </div>
            </div>
        </section>
    );
}
