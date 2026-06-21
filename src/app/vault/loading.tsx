import { SkeletonGrid, SkeletonPageHeader } from "@/components/ui/LoadingSkeleton";

export default function VaultLoading() {
  return (
    <div className="page-container py-10">
      <SkeletonPageHeader />
      <SkeletonGrid count={6} cols={3} />
    </div>
  );
}
