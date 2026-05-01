import Link from "next/link";

export default function FooterCTA() {
    return (
        <section className="bg-stone-50">
            <div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
                <h2 className="text-4xl md:text-6xl font-semibold tracking-tight text-stone-900 max-w-3xl leading-[1.05]">
                    Pick a side. Start a booklet.
                </h2>
                <p className="mt-6 text-lg text-stone-600 max-w-xl">
                    Titchybooks are not PDFs. They are physical objects that
                    circulate between people.
                </p>
                <div className="mt-10 grid sm:grid-cols-2 gap-4 max-w-2xl">
                    <Link
                        href="/register?audience=business"
                        className="flex flex-col justify-between p-6 rounded-sm bg-[#B4462B] text-stone-50 hover:brightness-110 transition min-h-[140px]"
                    >
                        <span className="text-xs uppercase tracking-[0.2em] opacity-70">
                            Outernet Commerce
                        </span>
                        <span className="text-xl font-medium">
                            For Businesses →
                        </span>
                    </Link>
                    <Link
                        href="/create"
                        className="flex flex-col justify-between p-6 rounded-sm bg-[#1F3A5F] text-stone-50 hover:brightness-110 transition min-h-[140px]"
                    >
                        <span className="text-xs uppercase tracking-[0.2em] opacity-70">
                            Outernet Publishing
                        </span>
                        <span className="text-xl font-medium">
                            Create a Titchybook →
                        </span>
                    </Link>
                </div>
            </div>
        </section>
    );
}
