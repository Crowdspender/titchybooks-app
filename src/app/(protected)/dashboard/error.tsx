"use client";

import ErrorDisplay from "@/components/ui/ErrorDisplay";

export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorDisplay reset={reset} />;
}
