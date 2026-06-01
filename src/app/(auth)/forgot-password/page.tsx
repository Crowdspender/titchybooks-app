import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";
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
            className="inline-flex items-center gap-0.5 text-2xl font-semibold tracking-tight no-underline"
            style={{ color: "var(--color-text)" }}
          >
            Titchybooks
            <span
              className="inline-block w-2 h-2 rounded-full mb-3"
              style={{ background: "var(--color-primary)" }}
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
