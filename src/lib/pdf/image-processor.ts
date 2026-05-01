import sharp from "sharp";

/**
 * Process an image buffer for a specific panel:
 * 1. Resize to fill the panel at 300 DPI (cover + center crop)
 * 2. Optionally rotate 180° for bottom-row panels
 * 3. Output as PNG for PDF embedding
 */
export async function processImageForPanel(
  imageBuffer: Buffer,
  panelWidthMm: number,
  panelHeightMm: number,
  rotation: number = 0
): Promise<Buffer> {
  const targetWidthPx = Math.round((panelWidthMm / 25.4) * 300);
  const targetHeightPx = Math.round((panelHeightMm / 25.4) * 300);

  let pipeline = sharp(imageBuffer)
    .resize(targetWidthPx, targetHeightPx, {
      fit: "cover",
      position: "centre",
    });

  if (rotation === 180) {
    pipeline = pipeline.rotate(180);
  }

  return pipeline.png().toBuffer();
}
