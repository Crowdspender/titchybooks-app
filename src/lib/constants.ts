/**
 * Submission state values. Kept in sync with the SubmissionStatus enum in
 * prisma/schema.prisma. Declared as a const object rather than a TS enum so
 * the values remain plain string literals: assignable to Prisma's generated
 * enum types and safe to import from client components.
 */
export const SubmissionStatus = {
  DRAFT: "DRAFT",
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  PROCESSING: "PROCESSING",
  FAILED: "FAILED",
} as const;

export type SubmissionStatus =
  (typeof SubmissionStatus)[keyof typeof SubmissionStatus];

/** Valid status values for validation. */
export const VALID_STATUSES = Object.values(SubmissionStatus);

export const SubmissionMode = {
  LEGACY_UPLOAD: "LEGACY_UPLOAD",
  EDITOR: "EDITOR",
  TEMPLATE: "TEMPLATE",
} as const;

export type SubmissionMode =
  (typeof SubmissionMode)[keyof typeof SubmissionMode];

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
