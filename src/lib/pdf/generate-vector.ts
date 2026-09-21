import { PDFDocument, StandardFonts } from 'pdf-lib';
import { uploadToS3 } from '@/lib/s3';
import { renderSceneToPdfPage } from './vector-render';
import { renderEditorSceneForPanel } from './editor-render';
import { PANELS, mmToPoints, A4_LANDSCAPE_WIDTH_MM, A4_LANDSCAPE_HEIGHT_MM } from './layout';
import { InvalidRenderInput, parseRenderSnapshot, type RenderSnapshot } from './snapshot';
import { drawBackCoverBrand, loadAssetBuffers, uploadPreview, type RenderArtifacts } from './render-output';

export async function generateTitchybookPdfVector(snapshot: RenderSnapshot, prefix: string): Promise<RenderArtifacts> {
  const input = parseRenderSnapshot(snapshot);
  if (input.mode !== 'EDITOR') throw new InvalidRenderInput('Vector rendering requires editor scenes');
  const assets = await loadAssetBuffers(input);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([mmToPoints(A4_LANDSCAPE_WIDTH_MM), mmToPoints(A4_LANDSCAPE_HEIGHT_MM)]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const previews: RenderArtifacts['previews'] = [];
  for (const panel of PANELS) {
    const entry = input.pages.find(p => p.pageLabel === panel.pageLabel)!;
    const width = mmToPoints(panel.width);
    const height = mmToPoints(panel.height);
    const { pdfDoc } = await renderSceneToPdfPage(entry.scene, width, height, assets, panel.rotation);
    const [embedded] = await pdf.embedPdf(await pdfDoc.save());
    const x = mmToPoints(panel.x);
    const y = mmToPoints(A4_LANDSCAPE_HEIGHT_MM - panel.y - panel.height);
    page.drawPage(embedded, { x, y, xScale: 1, yScale: 1 });
    if (panel.pageLabel === 'BACK_COVER') drawBackCoverBrand(page, font, x, y, width, height);
    previews.push(await uploadPreview(prefix, entry.pageLabel, await renderEditorSceneForPanel(entry.scene, panel, assets)));
  }
  const pdfS3Key = `${prefix}/titchybook.pdf`;
  await uploadToS3(pdfS3Key, Buffer.from(await pdf.save()), 'application/pdf');
  return { pdfS3Key, previews };
}
