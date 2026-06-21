import Link from "next/link";

export default function NotFound() {
  return (
    <div className="page-container py-24 flex flex-col items-center text-center">
      {/* Book icon */}
      <div
        className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-6"
        style={{ background: "var(--color-primary-muted)" }}
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-primary)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
        </svg>
      </div>

      <p className="section-label mb-2">404</p>
      <h1
        className="text-3xl font-semibold tracking-tight mb-3"
        style={{ color: "var(--color-text)" }}
      >
        Page not found
      </h1>
      <p
        className="text-sm max-w-sm mb-8"
        style={{ color: "var(--color-text-muted)" }}
      >
        The page you&apos;re looking for doesn&apos;t exist or has been moved.
        Head back to your dashboard to continue.
      </p>

      <Link href="/dashboard" className="btn btn-primary">
        Go to dashboard
      </Link>
    </div>
  );
}
