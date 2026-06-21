import RegisterForm from "@/components/auth/RegisterForm";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";

export default function RegisterPage() {
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
            Create your account and start publishing
          </p>
        </div>

        {/* Card */}
        <div
          className="card p-8"
          style={{ boxShadow: "var(--shadow-lg)" }}
        >
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-8">
                <svg
                  className="animate-spin"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray="50"
                    strokeDashoffset="15"
                    style={{ color: "var(--color-text-muted)" }}
                  />
                </svg>
              </div>
            }
          >
            <RegisterForm />
          </Suspense>
        </div>

        <p
          className="mt-6 text-center text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          Already have an account?{" "}
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
