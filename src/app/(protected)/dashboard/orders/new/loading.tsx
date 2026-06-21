import {
  SkeletonBlock,
  SkeletonPageHeader,
} from "@/components/ui/LoadingSkeleton";

export default function NewOrderLoading() {
  return (
    <div className="page-container py-10">
      {/* Header with back button */}
      <div className="mb-6 flex items-start justify-between">
        <SkeletonPageHeader />
        <SkeletonBlock className="h-8 w-36" />
      </div>

      {/* Order panel placeholder */}
      <div
        className="card p-6 space-y-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        <SkeletonBlock className="h-4 w-40" />
        <SkeletonBlock className="h-10 w-full" />
        <SkeletonBlock className="h-4 w-56" />
        <SkeletonBlock className="h-10 w-full" />
        <SkeletonBlock className="h-4 w-32" />
        <SkeletonBlock className="h-12 w-full" />
        <SkeletonBlock className="h-10 w-48 ml-auto" />
      </div>
    </div>
  );
}
