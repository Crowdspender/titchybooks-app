import { SkeletonBlock, SkeletonCard } from "@/components/ui/LoadingSkeleton";

export default function AdminTemplatesLoading() {
  return (
    <>
      {/* Tab bar skeleton */}
      <div
        className="page-container pt-6 flex gap-1 text-sm"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <SkeletonBlock className="h-10 w-24" />
        <SkeletonBlock className="h-10 w-20" />
        <SkeletonBlock className="h-10 w-20" />
      </div>

      {/* Template list */}
      <div className="page-container py-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} lines={3} />
          ))}
        </div>
      </div>
    </>
  );
}
