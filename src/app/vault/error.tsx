"use client";

import ErrorDisplay from "@/components/ui/ErrorDisplay";

export default function VaultError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorDisplay reset={reset} />;
}
