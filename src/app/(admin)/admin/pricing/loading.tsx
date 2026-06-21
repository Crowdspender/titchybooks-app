import { SkeletonBlock } from "@/components/ui/LoadingSkeleton";

export default function AdminPricingLoading() {
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

      {/* Pricing form skeleton */}
      <div className="page-container py-8">
        <div
          className="card p-6 space-y-5 max-w-2xl"
          style={{ borderColor: "var(--color-border)" }}
        >
          <SkeletonBlock className="h-5 w-40" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <SkeletonBlock className="h-3 w-28" />
              <SkeletonBlock className="h-10 w-full" />
            </div>
          ))}
          <SkeletonBlock className="h-10 w-40" />
        </div>
      </div>
    </>
  );
}
