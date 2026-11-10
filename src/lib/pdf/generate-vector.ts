import { PDFDocument, StandardFonts } from 'pdf-lib';
import { uploadPdfArtifact, drawBackCoverBrand, loadAssetBuffers, uploadPreview, type RenderArtifacts } from './render-output';
import { renderSceneToPdfPage } from './vector-render';
import { renderEditorSceneForReading } from './editor-render';
import { PANELS, mmToPoints, A4_LANDSCAPE_WIDTH_MM, A4_LANDSCAPE_HEIGHT_MM } from './layout';
import { InvalidRenderInput, parseRenderSnapshot, type RenderSnapshot } from './snapshot';
import { applyPdfMetadata, buildReadingPdf } from './reading-pdf';
import { DEFAULT_PRINT_PROFILE, READING_ORDER } from './print-profile';
import { describeArtifact, PRINT_SHEET_FILENAME, READING_PDF_FILENAME } from './artifacts';
import type { RenderContext } from './generate';

/**
 * Legacy/manual vector renderer.
 *
 * Vector output is not part of the qualified AI profile: it stays available for
 * existing workflows only. It still produces the same dual artifact set so
 * every completed render publishes a consistent pair, with the reading pages
 * rasterised from the identical scene graph.
 */
export async function generateTitchybookPdfVector(
  snapshot: RenderSnapshot,
  prefix: string,
  context: RenderContext = {},
): Promise<RenderArtifacts> {
  const input = parseRenderSnapshot(snapshot);
  if (input.mode !== 'EDITOR') throw new InvalidRenderInput('Vector rendering requires editor scenes');
  const assets = await loadAssetBuffers(input);
  const title = input.version === 2 ? input.title : null;

  const readingPages: Array<{ pageLabel: (typeof READING_ORDER)[number]; png: Buffer }> = [];
  for (const pageLabel of READING_ORDER) {
    const entry = input.pages.find((p) => p.pageLabel === pageLabel);
    if (!entry) throw new InvalidRenderInput(`Missing page ${pageLabel}`);
    readingPages.push({ pageLabel, png: await renderEditorSceneForReading(entry.scene, assets) });
  }

  const previews: RenderArtifacts['previews'] = [];
  for (const page of readingPages) {
    previews.push(await uploadPreview(prefix, page.pageLabel, page.png));
  }

  const readingBytes = await buildReadingPdf(readingPages, title);
  const readingPdfS3Key = await uploadPdfArtifact(prefix, READING_PDF_FILENAME, readingBytes);

  const pdf = await PDFDocument.create();
  applyPdfMetadata(pdf, title, 'print');
  const page = pdf.addPage([mmToPoints(A4_LANDSCAPE_WIDTH_MM), mmToPoints(A4_LANDSCAPE_HEIGHT_MM)]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (const panel of PANELS) {
    const entry = input.pages.find((p) => p.pageLabel === panel.pageLabel)!;
    const width = mmToPoints(panel.width);
    const height = mmToPoints(panel.height);
    const { pdfDoc } = await renderSceneToPdfPage(entry.scene, width, height, assets, panel.rotation);
    const [embedded] = await pdf.embedPdf(await pdfDoc.save());
    const x = mmToPoints(panel.x);
    const y = mmToPoints(A4_LANDSCAPE_HEIGHT_MM - panel.y - panel.height);
    page.drawPage(embedded, { x, y, xScale: 1, yScale: 1 });
    if (panel.pageLabel === 'BACK_COVER') drawBackCoverBrand(page, font, x, y, width, height);
  }
  const sheetBytes = Buffer.from(await pdf.save());
  const pdfS3Key = await uploadPdfArtifact(prefix, PRINT_SHEET_FILENAME, sheetBytes);

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
      renderJobId: context.renderJobId ?? '',
      printProfile: `${DEFAULT_PRINT_PROFILE.id}+vector`,
      templateId: input.version === 2 ? input.templateId : null,
      templateVersion: input.version === 2 ? input.templateVersion : null,
      title,
      createdAt: new Date().toISOString(),
      print: printDescriptor,
      reading: readingDescriptor,
    },
  };
}
