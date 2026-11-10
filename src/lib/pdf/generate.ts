import { PDFDocument, StandardFonts } from 'pdf-lib';
import { downloadFromS3 } from '@/lib/s3';
import { processImageForPanel } from './image-processor';
import {
  renderEditorSceneForPanel,
  renderEditorSceneForReading,
  READING_PAGE_HEIGHT_PX,
  READING_PAGE_WIDTH_PX,
} from './editor-render';
import { PANELS, mmToPoints, A4_LANDSCAPE_WIDTH_MM, A4_LANDSCAPE_HEIGHT_MM } from './layout';
import { parseRenderSnapshot, type RenderSnapshot } from './snapshot';
import {
  drawBackCoverBrand,
  loadAssetBuffers,
  uploadPdfArtifact,
  uploadPreview,
  type RenderArtifacts,
} from './render-output';
import { DEFAULT_PRINT_PROFILE, READING_ORDER } from './print-profile';
import {
  describeArtifact,
  PRINT_SHEET_FILENAME,
  READING_PDF_FILENAME,
} from './artifacts';
import { applyPdfMetadata, buildReadingPdf } from './reading-pdf';
import type { PageLabel } from '@/lib/constants';

/**
 * Render the finished book. Two artifacts come out of one immutable snapshot:
 *
 * - `readingPdfS3Key`: eight upright 74 x 105 mm pages in READING_ORDER.
 * - `pdfS3Key`: the A4-landscape foldable sheet (compatibility geometry).
 *
 * The reading pages are rendered first and are the canonical view of the book;
 * the sheet only re-imposes those same page renders. Rendering is deliberately
 * independent of live database state and publication.
 */
export interface RenderContext {
  /** Render job id, recorded in the artifact manifest. */
  renderJobId?: string;
}

export async function generateTitchybookPdf(
  snapshot: RenderSnapshot,
  prefix: string,
  context: RenderContext = {},
): Promise<RenderArtifacts> {
  const input = parseRenderSnapshot(snapshot);
  if (input.mode === 'EDITOR' && input.renderer === 'vector') {
    // Vector stays available to legacy/manual workflows only. The qualified AI
    // profile is raster (see print-profile.ts).
    return (await import('./generate-vector')).generateTitchybookPdfVector(input, prefix, context);
  }

  const assetBuffers = input.mode === 'EDITOR' ? await loadAssetBuffers(input) : new Map();
  const title = input.version === 2 ? input.title : null;

  // --- 1. Canonical upright pages, in explicit reading order ----------------
  const readingPages: Array<{ pageLabel: PageLabel; png: Buffer }> = [];
  for (const pageLabel of READING_ORDER) {
    if (input.mode === 'EDITOR') {
      const entry = input.pages.find((candidate) => candidate.pageLabel === pageLabel);
      if (!entry) throw new Error(`Missing page ${pageLabel} in render snapshot`);
      readingPages.push({ pageLabel, png: await renderEditorSceneForReading(entry.scene, assetBuffers) });
    } else {
      const entry = input.images.find((candidate) => candidate.pageLabel === pageLabel);
      if (!entry) throw new Error(`Missing page ${pageLabel} in render snapshot`);
      // Legacy uploads are whole-page photos: fit them to the reading page,
      // never rotate (rotation is an imposition concern only).
      const png = await processImageForPanel(
        await downloadFromS3(entry.s3Key),
        DEFAULT_PRINT_PROFILE.readingPage.widthMm,
        DEFAULT_PRINT_PROFILE.readingPage.heightMm,
        0,
      );
      readingPages.push({ pageLabel, png });
    }
  }

  // Previews always come from the upright reading render, so a thumbnail can
  // never appear rotated relative to the book a reader downloads.
  const previews: RenderArtifacts['previews'] = [];
  for (const page of readingPages) {
    previews.push(await uploadPreview(prefix, page.pageLabel, page.png));
  }

  // --- 2. Reading PDF: eight upright pages ---------------------------------
  const readingBytes = await buildReadingPdf(readingPages, title);
  const readingPdfS3Key = await uploadPdfArtifact(prefix, READING_PDF_FILENAME, readingBytes);

  // --- 3. Print sheet: the same pages imposed onto A4 ----------------------
  const sheet = await PDFDocument.create();
  applyPdfMetadata(sheet, title, 'print');
  const sheetPage = sheet.addPage([
    mmToPoints(A4_LANDSCAPE_WIDTH_MM),
    mmToPoints(A4_LANDSCAPE_HEIGHT_MM),
  ]);
  const brandFont = await sheet.embedFont(StandardFonts.HelveticaBold);
  for (const panel of PANELS) {
    let png: Buffer;
    if (input.mode === 'EDITOR') {
      const entry = input.pages.find((candidate) => candidate.pageLabel === panel.pageLabel)!;
      png = await renderEditorSceneForPanel(entry.scene, panel, assetBuffers);
    } else {
      const entry = input.images.find((candidate) => candidate.pageLabel === panel.pageLabel)!;
      png = await processImageForPanel(
        await downloadFromS3(entry.s3Key),
        panel.width,
        panel.height,
        panel.rotation,
      );
    }
    const image = await sheet.embedPng(png);
    const x = mmToPoints(panel.x);
    const y = mmToPoints(A4_LANDSCAPE_HEIGHT_MM - panel.y - panel.height);
    const width = mmToPoints(panel.width);
    const height = mmToPoints(panel.height);
    sheetPage.drawImage(image, { x, y, width, height });
    if (panel.pageLabel === 'BACK_COVER') drawBackCoverBrand(sheetPage, brandFont, x, y, width, height);
  }
  const sheetBytes = Buffer.from(await sheet.save());
  const pdfS3Key = await uploadPdfArtifact(prefix, PRINT_SHEET_FILENAME, sheetBytes);

  // --- 4. Artifact manifest ------------------------------------------------
  // Both files exist before either key is returned; publication happens later,
  // under the render fence (see publishRender).
  const [printDescriptor, readingDescriptor] = await Promise.all([
    describeArtifact({ kind: 'print', s3Key: pdfS3Key, bytes: sheetBytes }),
    describeArtifact({ kind: 'reading', s3Key: readingPdfS3Key, bytes: readingBytes }),
  ]);

  return {
    pdfS3Key,
    readingPdfS3Key,
    previews,
    artifactManifest: {
      schemaVersion: 1,
      submissionId: input.submissionId,
      submissionRevision: input.version === 2 ? input.submissionRevision : 0,
      renderJobId: context.renderJobId ?? renderJobIdFromPrefix(prefix),
      printProfile: input.version === 2 ? input.printProfile : 'legacy-v1',
      templateId: input.version === 2 ? input.templateId : null,
      templateVersion: input.version === 2 ? input.templateVersion : null,
      title,
      createdAt: new Date().toISOString(),
      print: printDescriptor,
      reading: readingDescriptor,
    },
  };
}

/** Attempt prefixes end with `<attempt>-<claimToken>`; the job id is two levels up. */
function renderJobIdFromPrefix(prefix: string): string {
  const segments = prefix.split('/').filter(Boolean);
  return segments.length >= 2 ? segments[segments.length - 2] : prefix;
}

export { READING_PAGE_WIDTH_PX, READING_PAGE_HEIGHT_PX };
