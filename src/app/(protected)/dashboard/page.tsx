import SubmissionList from "@/components/submissions/SubmissionList";
import Link from "next/link";
import ContinueEditingButton from "@/components/dashboard/ContinueEditingButton";

export default function DashboardPage() {
  return (
    <div className="page-container py-10">
      {/* Page header */}
      <div className="mb-8">
        <p className="section-label mb-2">Your library</p>
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          My Titchybooks
        </h1>
        <p
          className="mt-1.5 text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          Manage your drafts, submissions, and print orders.
        </p>
      </div>

      {/* Toolbar */}
      <div
        className="flex flex-wrap items-center gap-2 mb-6 pb-6"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <Link href="/dashboard/orders" className="btn btn-outline btn-sm">
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M1 3h12M1 7h12M1 11h12" />
          </svg>
          My Orders
        </Link>
        <Link href="/create/templates" className="btn btn-outline btn-sm">
          From Template
        </Link>
        <ContinueEditingButton />
        <div className="flex-1" />
        <Link href="/create?new=true" className="btn btn-primary btn-sm">
          + New Book
        </Link>
      </div>

      <SubmissionList />
    </div>
  );
}
