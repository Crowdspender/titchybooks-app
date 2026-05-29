import LoginForm from "@/components/auth/LoginForm";
import Link from "next/link";
import { Suspense } from "react";

export default function LoginPage() {
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
            Titchybook
            <span
              className="inline-block w-2 h-2 rounded-full mb-3"
              style={{ background: "var(--color-primary)" }}
            />
          </Link>
          <p
            className="mt-2 text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            Sign in to continue to your account
          </p>
        </div>

        {/* Card */}
        <div
          className="card p-8"
          style={{ boxShadow: "var(--shadow-lg)" }}
        >
          <Suspense
            fallback={
              <div
                className="text-center py-4"
                style={{ color: "var(--color-text-muted)" }}
              >
                Loading...
              </div>
            }
          >
            <LoginForm />
          </Suspense>
        </div>

        <p
          className="mt-6 text-center text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          Don&apos;t have an account?{" "}
          <Link
            href="/register"
            className="font-medium no-underline"
            style={{ color: "var(--color-primary)" }}
          >
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
