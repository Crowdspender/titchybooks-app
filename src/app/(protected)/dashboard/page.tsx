import SubmissionList from "@/components/submissions/SubmissionList";
import Link from "next/link";
import ContinueEditingButton from "@/components/dashboard/ContinueEditingButton";

export default function DashboardPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">My Titchybooks</h1>
        <div className="flex gap-2">
          <Link
            href="/dashboard/orders"
            className="px-4 py-2 border border-stone-300 text-stone-700 rounded-md hover:bg-stone-50 text-sm"
          >
            My Orders
          </Link>
          <Link
            href="/create/templates"
            className="px-4 py-2 border border-stone-300 text-stone-700 rounded-md hover:bg-stone-50 text-sm"
          >
            From Template
          </Link>
          <ContinueEditingButton />
          <Link
            href="/create?new=true"
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm"
          >
            + New Book
          </Link>
        </div>
      </div>
      <SubmissionList />
    </div>
  );
}
