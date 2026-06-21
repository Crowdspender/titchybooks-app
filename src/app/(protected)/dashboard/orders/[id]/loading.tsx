import {
  SkeletonBlock,
  SkeletonDetailCard,
  SkeletonPageHeader,
} from "@/components/ui/LoadingSkeleton";

export default function OrderDetailLoading() {
  return (
    <div className="page-container py-10">
      {/* Header with back button */}
      <div className="mb-8 flex items-start justify-between">
        <SkeletonPageHeader subtitle={false} />
        <SkeletonBlock className="h-8 w-28" />
      </div>

      {/* Two-column detail cards */}
      <div className="grid gap-4 md:grid-cols-2">
        <SkeletonDetailCard rows={6} />
        <SkeletonDetailCard rows={5} />
        <SkeletonDetailCard rows={4} className="md:col-span-2" />
      </div>
    </div>
  );
}
