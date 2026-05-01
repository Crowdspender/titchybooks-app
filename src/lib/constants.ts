/**
 * Submission status enum for type safety.
 * SQLite doesn't support native enums, so we use string in DB
 * but enforce type safety in code.
 */
export enum SubmissionStatus {
  DRAFT = "DRAFT",
  PENDING = "PENDING",
  APPROVED = "APPROVED",
  REJECTED = "REJECTED",
  PROCESSING = "PROCESSING",
  FAILED = "FAILED",
}

/**
 * Valid status values for validation
 */
export const VALID_STATUSES = Object.values(SubmissionStatus);

export enum SubmissionMode {
  LEGACY_UPLOAD = "LEGACY_UPLOAD",
  EDITOR = "EDITOR",
  TEMPLATE = "TEMPLATE",
}

export const VALID_SUBMISSION_MODES = Object.values(SubmissionMode);

export const PAGE_LABELS = [
  "FRONT_COVER",
  "BACK_COVER",
  "PAGE_2",
  "PAGE_3",
  "PAGE_4",
  "PAGE_5",
  "PAGE_6",
  "PAGE_7",
] as const;

export type PageLabel = (typeof PAGE_LABELS)[number];

export const PAGE_LABEL_DISPLAY: Record<PageLabel, string> = {
  FRONT_COVER: "Front Cover",
  BACK_COVER: "Back Cover",
  PAGE_2: "Page 2",
  PAGE_3: "Page 3",
  PAGE_4: "Page 4",
  PAGE_5: "Page 5",
  PAGE_6: "Page 6",
  PAGE_7: "Page 7",
};

export const ACCEPTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
