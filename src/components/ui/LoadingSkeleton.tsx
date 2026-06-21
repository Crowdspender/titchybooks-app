/**
 * Reusable skeleton primitives for loading.tsx files.
 * All skeletons use the `animate-pulse` utility and design tokens.
 */

export function SkeletonBlock({
  className = "",
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={`animate-pulse rounded-md ${className}`}
      style={{ background: "var(--color-border)", ...style }}
    />
  );
}

export function SkeletonPageHeader({
  subtitle = true,
}: {
  subtitle?: boolean;
}) {
  return (
    <div className="mb-8 space-y-3">
      <SkeletonBlock className="h-3 w-24" />
      <SkeletonBlock className="h-8 w-56" />
      {subtitle && <SkeletonBlock className="h-4 w-80" />}
    </div>
  );
}

export function SkeletonCard({
  lines = 2,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      className={`card p-5 space-y-3 ${className}`}
      style={{ borderColor: "var(--color-border)" }}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBlock
          key={i}
          className="h-4"
          style={{ width: i === 0 ? "60%" : "40%" }}
        />
      ))}
    </div>
  );
}

export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} lines={2} />
      ))}
    </div>
  );
}

export function SkeletonGrid({
  count = 6,
  cols = 3,
}: {
  count?: number;
  cols?: 2 | 3;
}) {
  const colClass = cols === 3
    ? "sm:grid-cols-2 lg:grid-cols-3"
    : "sm:grid-cols-2";
  return (
    <div className={`grid gap-4 ${colClass}`}>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} lines={3} />
      ))}
    </div>
  );
}

/**
 * Skeleton for a detail card (used on order detail / new order pages).
 */
export function SkeletonDetailCard({
  rows = 5,
  className = "",
}: {
  rows?: number;
  className?: string;
}) {
  return (
    <div
      className={`card p-6 space-y-4 ${className}`}
      style={{ borderColor: "var(--color-border)" }}
    >
      <SkeletonBlock className="h-3 w-20" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between">
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-4 w-32" />
        </div>
      ))}
    </div>
  );
}
