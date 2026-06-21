import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";
import Image from "next/image";
import Link from "next/link";

export default function ForgotPasswordPage() {
    return (
        <div
            className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-12"
            style={{ background: "var(--color-background)" }}
        >
            <div className="w-full max-w-md">
                {/* Brand header */}
                <div className="text-center mb-8">
                    <Link
                        href="/"
                        className="inline-flex items-center justify-center no-underline"
                    >
                        <Image
                            src="/titchybooks-logo.png"
                            alt="Titchybooks"
                            width={56}
                            height={56}
                            className="h-14 w-auto"
                            priority
                        />
                    </Link>
                    <p
                        className="mt-2 text-sm"
                        style={{ color: "var(--color-text-muted)" }}
                    >
                        Enter your email to reset your password
                    </p>
                </div>

                {/* Card */}
                <div
                    className="card p-8"
                    style={{ boxShadow: "var(--shadow-lg)" }}
                >
                    <ForgotPasswordForm />
                </div>

                <p
                    className="mt-6 text-center text-sm"
                    style={{ color: "var(--color-text-muted)" }}
                >
                    Remember your password?{" "}
                    <Link
                        href="/login"
                        className="font-medium no-underline"
                        style={{ color: "var(--color-primary)" }}
                    >
                        Sign in
                    </Link>
                </p>
            </div>
        </div>
    );
}
