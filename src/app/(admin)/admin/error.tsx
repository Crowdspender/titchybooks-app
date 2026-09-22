"use client";

import ErrorDisplay from "@/components/ui/ErrorDisplay";

export default function AdminError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorDisplay reset={reset} />;
}
