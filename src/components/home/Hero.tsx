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
                            Create a Titchybook
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
                    <div className="relative">
                        {/* Left book */}
                        <div
                            className="absolute -left-16 top-8 w-[148px] h-[210px] rounded-lg"
                            style={{
                                background: "var(--color-border-strong)",
                                boxShadow:
                                    "0 20px 40px -12px rgba(28, 25, 23, 0.15), 0 8px 16px -8px rgba(28, 25, 23, 0.1)",
                                transform: "rotate(-10deg)",
                            }}
                        >
                            <div
                                className="absolute bottom-3 left-3 text-[10px] tracking-widest uppercase"
                                style={{ color: "var(--color-text-subtle)" }}
                            >
                                A7 · 74 × 105mm
                            </div>
                        </div>
                        {/* Right book (terracotta) */}
                        <div
                            className="absolute -right-14 top-4 w-[148px] h-[210px] rounded-lg p-3 flex flex-col justify-between"
                            style={{
                                background: "var(--color-primary)",
                                boxShadow:
                                    "0 24px 48px -12px rgba(180, 70, 43, 0.25), 0 8px 16px -8px rgba(28, 25, 23, 0.12)",
                                transform: "rotate(7deg)",
                                color: "var(--color-text-inverse)",
                            }}
                        >
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
                        {/* Center book */}
                        <div
                            className="relative w-[148px] h-[210px] rounded-lg p-4 flex flex-col justify-between"
                            style={{
                                background: "var(--color-surface-dark)",
                                boxShadow:
                                    "0 32px 64px -16px rgba(28, 25, 23, 0.3), 0 12px 24px -8px rgba(28, 25, 23, 0.15)",
                                color: "var(--color-text-inverse)",
                            }}
                        >
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
