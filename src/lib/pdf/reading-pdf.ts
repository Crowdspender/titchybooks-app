import { PDFDocument } from "pdf-lib";
import type { PageLabel } from "@/lib/constants";
import { mmToPoints } from "./layout";
import { DEFAULT_PRINT_PROFILE, PRINT_PROFILE_DPI } from "./print-profile";

/**
 * Assemble the eight-page reading PDF from canonical upright page renders.
 *
 * The reading PDF is the canonical view of the book: one 74 x 105 mm page per
 * label, in READING_ORDER. The A4 sheet only re-imposes the same renders.
 */
export async function buildReadingPdf(
  pages: Array<{ pageLabel: PageLabel; png: Buffer }>,
  title: string | null,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const label = title || "Titchybooks";
  doc.setTitle(`${label} (reading copy)`);
  doc.setAuthor("Titchybooks");
  doc.setCreator("Titchybooks");
  doc.setProducer(`Titchybooks ${DEFAULT_PRINT_PROFILE.id} @ ${PRINT_PROFILE_DPI} DPI`);
  for (const page of pages) {
    const pdfPage = doc.addPage([
      mmToPoints(DEFAULT_PRINT_PROFILE.readingPage.widthMm),
      mmToPoints(DEFAULT_PRINT_PROFILE.readingPage.heightMm),
    ]);
    const image = await doc.embedPng(page.png);
    pdfPage.drawImage(image, { x: 0, y: 0, width: pdfPage.getWidth(), height: pdfPage.getHeight() });
  }
  return Buffer.from(await doc.save());
}

/** Metadata helper shared by both output documents. */
export function applyPdfMetadata(
  doc: PDFDocument,
  title: string | null,
  kind: "print" | "reading",
): void {
  const label = title || "Titchybooks";
  doc.setTitle(kind === "print" ? `${label} (foldable print sheet)` : `${label} (reading copy)`);
  doc.setAuthor("Titchybooks");
  doc.setCreator("Titchybooks");
  doc.setProducer(`Titchybooks ${DEFAULT_PRINT_PROFILE.id} @ ${PRINT_PROFILE_DPI} DPI`);
}
