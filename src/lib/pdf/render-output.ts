import sharp from 'sharp';
import { rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { downloadFromS3, uploadToS3 } from '@/lib/s3';
import { BACK_COVER_BRAND_BAND_PX, BACK_COVER_BRAND_TEXT, EDITOR_PAGE_HEIGHT_PX, EDITOR_PAGE_WIDTH_PX, EDITOR_SAFE_MARGIN_PX } from '@/lib/editor/constants';
import type { RenderSnapshot } from './snapshot';
import type { PageLabel } from '@/lib/constants';

export interface RenderArtifacts {
  pdfS3Key: string;
  previews: Array<{ pageLabel: PageLabel; s3Key: string }>;
}
export async function loadAssetBuffers(input: RenderSnapshot) {
  return new Map(await Promise.all(input.assets.map(async asset => {
    const buffer = await downloadFromS3(asset.s3Key);
    const metadata = !asset.width || !asset.height ? await sharp(buffer).metadata() : null;
    return [asset.id, { buffer, mimeType: asset.mimeType, width: asset.width ?? metadata?.width ?? 1,
      height: asset.height ?? metadata?.height ?? 1 }] as const;
  })));
}
export async function uploadPreview(prefix: string, pageLabel: PageLabel, png: Buffer) {
  const s3Key = `${prefix}/previews/${pageLabel}.png`;
  const buffer = await sharp(png).resize(200, null, { withoutEnlargement: true }).png().toBuffer();
  await uploadToS3(s3Key, buffer, 'image/png');
  return { pageLabel, s3Key };
}

// Shared branding preserves the existing raster/vector imposition geometry.
export function drawBackCoverBrand(page: PDFPage, font: PDFFont, x: number, y: number, width: number, height: number) {
  const sx = width / EDITOR_PAGE_WIDTH_PX;
  const sy = height / EDITOR_PAGE_HEIGHT_PX;
  const bandX = x + EDITOR_SAFE_MARGIN_PX * sx;
  const bandY = y + EDITOR_SAFE_MARGIN_PX * sy;
  const bandWidth = (EDITOR_PAGE_WIDTH_PX - EDITOR_SAFE_MARGIN_PX * 2) * sx;
  const bandHeight = BACK_COVER_BRAND_BAND_PX * sy;
  page.drawRectangle({ x: bandX, y: bandY, width: bandWidth, height: bandHeight, color: rgb(0.961, 0.961, 0.957) });
  page.drawRectangle({ x: bandX, y: bandY + bandHeight - 1, width: bandWidth, height: 1, color: rgb(0.839, 0.827, 0.82) });
  const size = bandHeight * 0.4;
  page.drawText(BACK_COVER_BRAND_TEXT, {
    x: x + (width - font.widthOfTextAtSize(BACK_COVER_BRAND_TEXT, size)) / 2,
    y: bandY + bandHeight / 2 - font.heightAtSize(size) / 2,
    size, font, color: rgb(0.27, 0.25, 0.24),
  });
}
