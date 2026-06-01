import Image from "next/image";
import Link from "next/link";

export default function Hero() {
    return (
        <section
            className="relative overflow-hidden"
            style={{
                background:
                    "linear-gradient(175deg, #F5F3EE 0%, #FAFAF7 60%, #F5F3EE 100%)",
                borderBottom: "1px solid var(--color-border)",
            }}
        >
            <div className="mx-auto max-w-6xl px-6 py-24 md:py-32 grid md:grid-cols-2 gap-12 items-center">
                <div>
                    <p className="section-label mb-6">
                        Outernet Publishing · Outernet Commerce
                    </p>
                    <h1
                        className="text-5xl md:text-7xl font-semibold tracking-tight leading-[1.05]"
                        style={{ color: "var(--color-text)" }}
                    >
                        Small booklets that people keep, carry, and share.
                    </h1>
                    <p
                        className="mt-6 text-lg max-w-xl leading-relaxed"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        Titchybooks are A7 printed micro-publications used by
                        businesses, creators, and communities to circulate ideas
                        in the physical world.
                    </p>
                    <div className="mt-10 flex flex-wrap gap-3">
                        <Link
                            href="/create"
                            className="btn btn-primary btn-lg"
                            style={{ background: "var(--color-surface-dark)" }}
                        >
                            Create a Titchybooks
                        </Link>
                        <Link
                            href="/register?audience=business"
                            className="btn btn-outline btn-lg"
                        >
                            For Businesses
                        </Link>
                    </div>
                    <p
                        className="mt-6 text-xs"
                        style={{ color: "var(--color-text-subtle)" }}
                    >
                        No credit card. Design, export PDF, or order a print
                        run.
                    </p>
                </div>

                <div className="relative h-[440px] flex items-center justify-center">
                    <div className="relative w-full h-full">
                        <Image
                            src="/hero-booklet.webp"
                            alt="Titchybooks - A7 micro-publications displayed in warm editorial style"
                            fill
                            priority
                            className="object-contain rounded-lg"
                            quality={95}
                            sizes="(max-width: 768px) 100vw, 50vw"
                            style={{
                                boxShadow:
                                    "0 32px 64px -16px rgba(28, 25, 23, 0.2), 0 12px 24px -8px rgba(28, 25, 23, 0.12)",
                            }}
                        />
                    </div>
                    <p
                        className="absolute bottom-0 left-0 right-0 text-center text-xs"
                        style={{ color: "var(--color-text-subtle)" }}
                    >
                        Shown at actual size. Fits in a jacket pocket.
                    </p>
                </div>
            </div>
        </section>
    );
}
