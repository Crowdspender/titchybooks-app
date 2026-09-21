import { PDFDocument, StandardFonts } from 'pdf-lib';
import { downloadFromS3, uploadToS3 } from '@/lib/s3';
import { processImageForPanel } from './image-processor';
import { renderEditorSceneForPanel } from './editor-render';
import { PANELS, mmToPoints, A4_LANDSCAPE_WIDTH_MM, A4_LANDSCAPE_HEIGHT_MM } from './layout';
import { parseRenderSnapshot, type RenderSnapshot } from './snapshot';
import { drawBackCoverBrand, loadAssetBuffers, uploadPreview, type RenderArtifacts } from './render-output';

// Rendering is deliberately independent of live database state and publication.
export async function generateTitchybookPdf(snapshot: RenderSnapshot, prefix: string): Promise<RenderArtifacts> {
  const input = parseRenderSnapshot(snapshot);
  if (input.mode === 'EDITOR' && input.renderer === 'vector') {
    return (await import('./generate-vector')).generateTitchybookPdfVector(input, prefix);
  }
  const assetBuffers = await loadAssetBuffers(input);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([mmToPoints(A4_LANDSCAPE_WIDTH_MM), mmToPoints(A4_LANDSCAPE_HEIGHT_MM)]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const previews: RenderArtifacts['previews'] = [];
  // Sequential panels bound the worker's peak raster memory.
  for (const panel of PANELS) {
    let png: Buffer;
    if (input.mode === 'EDITOR') {
      const entry = input.pages.find(p => p.pageLabel === panel.pageLabel)!;
      png = await renderEditorSceneForPanel(entry.scene, panel, assetBuffers);
      previews.push(await uploadPreview(prefix, entry.pageLabel, png));
    } else {
      const entry = input.images.find(p => p.pageLabel === panel.pageLabel)!;
      png = await processImageForPanel(await downloadFromS3(entry.s3Key), panel.width, panel.height, panel.rotation);
    }
    const image = await pdf.embedPng(png);
    const x = mmToPoints(panel.x);
    const y = mmToPoints(A4_LANDSCAPE_HEIGHT_MM - panel.y - panel.height);
    const width = mmToPoints(panel.width);
    const height = mmToPoints(panel.height);
    page.drawImage(image, { x, y, width, height });
    if (panel.pageLabel === 'BACK_COVER') drawBackCoverBrand(page, font, x, y, width, height);
  }
  const pdfS3Key = `${prefix}/titchybook.pdf`;
  await uploadToS3(pdfS3Key, Buffer.from(await pdf.save()), 'application/pdf');
  return { pdfS3Key, previews };
}
