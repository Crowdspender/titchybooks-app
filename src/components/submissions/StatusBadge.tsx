const BADGE_STYLES: Record<string, string> = {
  DRAFT: "badge-draft",
  PENDING: "badge-pending",
  APPROVED: "badge-approved",
  REJECTED: "badge-rejected",
  PROCESSING: "badge-processing",
  FAILED: "badge-rejected",
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${BADGE_STYLES[status] ?? "badge-draft"}`}>
      {status.replace("_", " ")}
    </span>
  );
}
