import {
  SkeletonBlock,
  SkeletonCard,
  SkeletonPageHeader,
} from "@/components/ui/LoadingSkeleton";

export default function OrdersLoading() {
  return (
    <div className="page-container py-10">
      {/* Header with back button */}
      <div className="mb-8 flex items-start justify-between">
        <SkeletonPageHeader subtitle={false} />
        <SkeletonBlock className="h-8 w-36" />
      </div>

      {/* Order list */}
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} lines={2} />
        ))}
      </div>
    </div>
  );
}
