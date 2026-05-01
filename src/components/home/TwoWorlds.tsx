import Link from "next/link";

const business = [
    "Replace flyers with keepable booklets",
    "Attach real-world perks — coffee, cakes, offers",
    "Create circulating physical marketing",
    "Funded promotions via the Outernet system",
    "Example: buy coffee → receive free cake via Titchybook token",
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
        <section className="border-b border-stone-200 bg-stone-50">
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <p className="text-xs uppercase tracking-[0.2em] text-stone-500 mb-4">
                    Two worlds, one format
                </p>
                <h2 className="text-3xl md:text-5xl font-semibold tracking-tight text-stone-900 mb-14 leading-tight">
                    Built equally for businesses
                    <br />
                    and creators.
                </h2>
                <div className="grid md:grid-cols-2 gap-6">
                    <div className="rounded-sm bg-[#B4462B] text-stone-50 p-8 md:p-10 flex flex-col">
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
                            className="mt-10 inline-flex w-fit items-center gap-2 px-5 py-3 bg-stone-50 text-stone-900 font-medium rounded-sm hover:bg-white"
                        >
                            Create a Business Titchybook →
                        </Link>
                    </div>

                    <div className="rounded-sm bg-[#1F3A5F] text-stone-50 p-8 md:p-10 flex flex-col">
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
                            className="mt-10 inline-flex w-fit items-center gap-2 px-5 py-3 bg-stone-50 text-stone-900 font-medium rounded-sm hover:bg-white"
                        >
                            Create a Personal Titchybook →
                        </Link>
                    </div>
                </div>
            </div>
        </section>
    );
}
