import {
  SkeletonBlock,
  SkeletonCard,
  SkeletonPageHeader,
} from "@/components/ui/LoadingSkeleton";

export default function DashboardLoading() {
  return (
    <div className="page-container py-10">
      <SkeletonPageHeader />

      {/* Toolbar skeleton */}
      <div
        className="flex flex-wrap items-center gap-2 mb-6 pb-6"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <SkeletonBlock className="h-8 w-24" />
        <SkeletonBlock className="h-8 w-28" />
        <SkeletonBlock className="h-8 w-36" />
        <div className="flex-1" />
        <SkeletonBlock className="h-8 w-24" />
      </div>

      {/* Submission list skeleton */}
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} lines={2} />
        ))}
      </div>
    </div>
  );
}
