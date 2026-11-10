import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import { A4_LANDSCAPE_HEIGHT_MM, A4_LANDSCAPE_WIDTH_MM, MM_TO_POINTS } from "./layout";
import { MIN_READING_PAGE_MM, READING_ORDER } from "./print-profile";

/**
 * Artifact descriptions shared by the renderer, the publisher and QA.
 *
 * A book is only "finished" when both files exist, match the manifest they were
 * published with, and can be parsed back as the expected documents. Anything
 * less is not an artifact set.
 */
export type ArtifactKind = "print" | "reading";

export const PRINT_SHEET_FILENAME = "titchybook-print-sheet-a4-fold.pdf";
export const READING_PDF_FILENAME = "titchybook-reading-74x105mm.pdf";

export interface ArtifactDescriptor {
  s3Key: string;
  bytes: number;
  sha256: string;
  contentType: string;
  pageCount: number;
  widthPt: number;
  heightPt: number;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  submissionId: string;
  /** Submission revision the artifacts were produced from. */
  submissionRevision: number;
  renderJobId: string;
  printProfile: string;
  templateId: string | null;
  templateVersion: number | null;
  title: string | null;
  createdAt: string;
  print: ArtifactDescriptor;
  reading: ArtifactDescriptor;
}

const descriptorSchema = z.object({
  s3Key: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.string().min(1),
  pageCount: z.number().int().positive(),
  widthPt: z.number().positive(),
  heightPt: z.number().positive(),
});

export const artifactManifestSchema = z.object({
  schemaVersion: z.literal(1),
  submissionId: z.string().min(1),
  submissionRevision: z.number().int().nonnegative(),
  renderJobId: z.string().min(1),
  printProfile: z.string().min(1),
  templateId: z.string().nullable(),
  templateVersion: z.number().int().nullable(),
  title: z.string().nullable(),
  createdAt: z.string().min(1),
  print: descriptorSchema,
  reading: descriptorSchema,
});

export class InvalidArtifact extends Error {}

export function parseArtifactManifest(value: unknown): ArtifactManifest | null {
  if (value === null || value === undefined) return null;
  const result = artifactManifestSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface PdfInspection {
  pageCount: number;
  pageWidthsPt: number[];
  pageHeightsPt: number[];
  imageXObjects: number;
  bytes: number;
}

/**
 * Parse a PDF byte stream and report the structure QA cares about: page count,
 * page geometry, and whether any image XObjects are actually embedded. A valid
 * container with no drawing operators is not a book.
 */
export async function inspectPdf(bytes: Buffer): Promise<PdfInspection> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    throw new InvalidArtifact("The PDF could not be parsed");
  }
  const pages = doc.getPages();
  if (pages.length === 0) throw new InvalidArtifact("The PDF has no pages");
  // Our raster path embeds one image XObject per page. Counting raw occurrences
  // keeps this independent of pdf-lib internals while still detecting an empty
  // or text-only container.
  const imageXObjects = (bytes.toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;
  return {
    pageCount: pages.length,
    pageWidthsPt: pages.map((page) => page.getWidth()),
    pageHeightsPt: pages.map((page) => page.getHeight()),
    imageXObjects,
    bytes: bytes.length,
  };
}

export function expectedGeometry(kind: ArtifactKind): {
  pageCount: number;
  widthPt: number;
  heightPt: number;
} {
  if (kind === "print") {
    return {
      pageCount: 1,
      widthPt: A4_LANDSCAPE_WIDTH_MM * MM_TO_POINTS,
      heightPt: A4_LANDSCAPE_HEIGHT_MM * MM_TO_POINTS,
    };
  }
  return {
    pageCount: READING_ORDER.length,
    widthPt: MIN_READING_PAGE_MM.widthMm * MM_TO_POINTS,
    heightPt: MIN_READING_PAGE_MM.heightMm * MM_TO_POINTS,
  };
}

export async function describeArtifact(input: {
  kind: ArtifactKind;
  s3Key: string;
  bytes: Buffer;
  contentType?: string;
}): Promise<ArtifactDescriptor> {
  const inspection = await inspectPdf(input.bytes);
  return {
    s3Key: input.s3Key,
    bytes: input.bytes.length,
    sha256: sha256(input.bytes),
    contentType: input.contentType ?? "application/pdf",
    pageCount: inspection.pageCount,
    // Persist the first page's geometry; every page of a kind shares it.
    widthPt: inspection.pageWidthsPt[0],
    heightPt: inspection.pageHeightsPt[0],
  };
}

/** Readable, deterministic filename for a download response. */
export function artifactFilename(kind: ArtifactKind, title: string | null | undefined): string {
  const base = (title ?? "titchybook")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60)
    .toLowerCase();
  return `${base || "titchybook"}-${kind === "print" ? "print-sheet-a4-fold.pdf" : "reading-74x105mm.pdf"}`;
}

export interface ArtifactDifference {
  code: string;
  detail: string;
}

/**
 * Verify one published artifact against its descriptor and expected geometry.
 * Returns human-readable differences; empty means the artifact is intact.
 */
export async function verifyArtifact(
  kind: ArtifactKind,
  descriptor: ArtifactDescriptor,
  bytes: Buffer,
): Promise<ArtifactDifference[]> {
  const differences: ArtifactDifference[] = [];
  if (bytes.length !== descriptor.bytes) {
    differences.push({
      code: "artifact-size",
      detail: `Expected ${descriptor.bytes} bytes, received ${bytes.length}`,
    });
  }
  const digest = sha256(bytes);
  if (digest !== descriptor.sha256) {
    differences.push({ code: "artifact-checksum", detail: "The artifact checksum does not match" });
    return differences;
  }
  let inspection: PdfInspection;
  try {
    inspection = await inspectPdf(bytes);
  } catch (error) {
    differences.push({
      code: "artifact-unreadable",
      detail: error instanceof Error ? error.message : "The PDF could not be parsed",
    });
    return differences;
  }
  const expected = expectedGeometry(kind);
  if (inspection.pageCount !== expected.pageCount) {
    differences.push({
      code: "artifact-page-count",
      detail: `Expected ${expected.pageCount} page(s), found ${inspection.pageCount}`,
    });
  }
  inspection.pageWidthsPt.forEach((width, index) => {
    const height = inspection.pageHeightsPt[index];
    if (Math.abs(width - expected.widthPt) > 1 || Math.abs(height - expected.heightPt) > 1) {
      differences.push({
        code: "artifact-page-size",
        detail: `Page ${index + 1} is ${width.toFixed(1)}x${height.toFixed(1)}pt, expected ${expected.widthPt.toFixed(1)}x${expected.heightPt.toFixed(1)}pt`,
      });
    }
  });
  if (inspection.imageXObjects < expected.pageCount) {
    differences.push({
      code: "artifact-empty-pages",
      detail: `Only ${inspection.imageXObjects} rendered page image(s) for ${expected.pageCount} page(s)`,
    });
  }
  return differences;
}

/** True when a manifest describes a complete, self-consistent artifact set. */
export function manifestCoversSubmission(
  manifest: ArtifactManifest,
  submission: { id: string; revision: number; pdfS3Key: string | null; readingPdfS3Key: string | null },
): boolean {
  return (
    manifest.submissionId === submission.id &&
    manifest.submissionRevision === submission.revision &&
    manifest.print.s3Key === submission.pdfS3Key &&
    manifest.reading.s3Key === submission.readingPdfS3Key
  );
}
