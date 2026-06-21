import { SkeletonGrid } from "@/components/ui/LoadingSkeleton";

export default function AdminLoading() {
  return (
    <div className="page-container py-10">
      <div className="mb-6 space-y-2">
        <div
          className="animate-pulse rounded-md h-3 w-20"
          style={{ background: "var(--color-border)" }}
        />
        <div
          className="animate-pulse rounded-md h-8 w-48"
          style={{ background: "var(--color-border)" }}
        />
      </div>
      <SkeletonGrid count={3} cols={3} />
    </div>
  );
}
