import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { downloadFromS3, uploadToS3, buildPdfKey } from "@/lib/s3";
import { SubmissionMode, SubmissionStatus } from "@/lib/constants";
import { parseEditorScene } from "@/lib/editor/schema";
import {
  BACK_COVER_BRAND_BAND_PX,
  BACK_COVER_BRAND_TEXT,
  EDITOR_PAGE_HEIGHT_PX,
  EDITOR_PAGE_WIDTH_PX,
  EDITOR_SAFE_MARGIN_PX,
} from "@/lib/editor/constants";
import { processImageForPanel } from "./image-processor";
import { renderEditorSceneForPanel } from "./editor-render";
import {
  PANELS,
  mmToPoints,
  A4_LANDSCAPE_WIDTH_MM,
  A4_LANDSCAPE_HEIGHT_MM,
} from "./layout";

/**
 * Generate the Titchybooks PDF for a submission.
 *
 * 1. Fetch submission images from DB
 * 2. Download all 8 images from S3
 * 3. Process each image (resize/crop/rotate) with sharp
 * 4. Compose into a single A4 landscape PDF with pdf-lib
 * 5. Upload PDF to S3
 * 6. Update submission record with pdfS3Key
 */
export async function generateTitchybookPdf(
  submissionId: string
): Promise<string> {
  await prisma.submission.update({
    where: { id: submissionId },
    data: { status: SubmissionStatus.PROCESSING },
  });

  try {
    const submission = await prisma.submission.findUniqueOrThrow({
      where: { id: submissionId },
      include: { images: true, pages: true, user: true },
    });

    let processed: Array<{ panel: (typeof PANELS)[number]; processed: Buffer }>;

    if (submission.mode === SubmissionMode.EDITOR) {
      const pageMap = new Map(submission.pages.map((page) => [page.pageLabel, page]));

      // Fetch template elements if this is an instance created from a template
      const templateElementsByPage: Map<string, Array<{ order: number; elementJson: string }>> = new Map();
      if (submission.templateId) {
        const templateElements = await prisma.templateElement.findMany({
          where: { templateId: submission.templateId },
          orderBy: { order: "asc" },
        });
        for (const te of templateElements) {
          const existing = templateElementsByPage.get(te.pageLabel) ?? [];
          existing.push({ order: te.order, elementJson: te.elementJson });
          templateElementsByPage.set(te.pageLabel, existing);
        }
      }

      const scenes = submission.pages.map((page) => {
        const userScene = parseEditorScene(page.sceneJson);

        // If there are template elements for this page, merge them
        const pageTemplateElements = templateElementsByPage.get(page.pageLabel) ?? [];
        if (pageTemplateElements.length > 0) {
          const parsedTemplateElements = pageTemplateElements.map((te) =>
            JSON.parse(te.elementJson) as import("@/lib/editor/schema").EditorElement
          );

          // Apply any per-instance text overrides to template text elements
          // so the rendered PDF reflects the user's edited text content. All
          // other template-element properties remain fixed.
          const textOverrides = userScene.templateTextOverrides ?? {};
          const templateElementsWithOverrides = parsedTemplateElements.map((el) =>
            el.type === "text" && textOverrides[el.id] !== undefined
              ? { ...el, text: textOverrides[el.id] }
              : el
          );

          // Template elements go first (below), then user elements (above)
          return {
            pageLabel: page.pageLabel,
            scene: {
              ...userScene,
              elements: [
                ...templateElementsWithOverrides,
                ...userScene.elements,
              ],
            },
          };
        }

        return {
          pageLabel: page.pageLabel,
          scene: userScene,
        };
      });

      // Index merged scenes by pageLabel so the render loop below uses the
      // merged output (template + user) instead of re-parsing raw sceneJson.
      const sceneByLabel = new Map(
        scenes.map(({ pageLabel, scene }) => [pageLabel, scene]),
      );

      const assetIds = Array.from(
        new Set(
          scenes.flatMap(({ scene }) =>
            scene.elements
              .filter((element) => element.type === "image")
              .map((element) => element.assetId)
          )
        )
      );

      const assets = await prisma.asset.findMany({
        where: {
          id: { in: assetIds },
        },
      });

      const assetBufferEntries = await Promise.all(
        assets.map(async (asset) => {
          const buffer = await downloadFromS3(asset.s3Key);
          let width = asset.width ?? 0;
          let height = asset.height ?? 0;

          if (width <= 0 || height <= 0) {
            const metadata = await sharp(buffer).metadata();
            width = metadata.width ?? 1;
            height = metadata.height ?? 1;
          }

          return [
            asset.id,
            {
              buffer,
              mimeType: asset.mimeType,
              width,
              height,
            },
          ] as const;
        })
      );

      const assetBuffers = new Map(assetBufferEntries);

      processed = await Promise.all(
        PANELS.map(async (panel) => {
          const pageRecord = pageMap.get(panel.pageLabel);
          if (!pageRecord) {
            throw new Error(`Missing editor page for panel: ${panel.pageLabel}`);
          }

          const scene = sceneByLabel.get(panel.pageLabel);
          if (!scene) {
            throw new Error(`Missing merged scene for panel: ${panel.pageLabel}`);
          }

          const rendered = await renderEditorSceneForPanel(scene, panel, assetBuffers);
          return { panel, processed: rendered };
        })
      );
    } else {
      const imageMap = new Map(submission.images.map((img) => [img.pageLabel, img]));

      const downloadPromises = PANELS.map(async (panel) => {
        const imageRecord = imageMap.get(panel.pageLabel);
        if (!imageRecord) {
          throw new Error(`Missing image for panel: ${panel.pageLabel}`);
        }
        const buffer = await downloadFromS3(imageRecord.s3Key);
        return { panel, buffer };
      });

      const downloads = await Promise.all(downloadPromises);

      processed = await Promise.all(
        downloads.map(async ({ panel, buffer }) => {
          const nextBuffer = await processImageForPanel(
            buffer,
            panel.width,
            panel.height,
            panel.rotation
          );
          return { panel, processed: nextBuffer };
        })
      );
    }

    const pdfDoc = await PDFDocument.create();
    const pageWidth = mmToPoints(A4_LANDSCAPE_WIDTH_MM);
    const pageHeight = mmToPoints(A4_LANDSCAPE_HEIGHT_MM);
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    const brandFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    for (const { panel, processed: pngBuffer } of processed) {
      const image = await pdfDoc.embedPng(pngBuffer);

      const pdfX = mmToPoints(panel.x);
      const pdfY = mmToPoints(A4_LANDSCAPE_HEIGHT_MM - panel.y - panel.height);
      const pdfWidth = mmToPoints(panel.width);
      const pdfHeight = mmToPoints(panel.height);

      page.drawImage(image, {
        x: pdfX,
        y: pdfY,
        width: pdfWidth,
        height: pdfHeight,
      });

      // Permanent branding for the back cover. The back cover panel is
      // rendered at the same height as its neighbours; we reproduce the
      // editor's reserved branding band (inside the bottom safe margin)
      // so the PDF output matches what users see in the editor canvas.
      // The band is drawn as an opaque rectangle that hides any scene
      // content underneath, mirroring the editor's overlay behaviour.
      if (panel.pageLabel === "BACK_COVER") {
        // Map editor-scene pixels onto the panel in PDF points. The scene
        // is stretched independently in X and Y when rendered into the
        // panel (see renderEditorSceneForPanel), so we need separate scales.
        const pxToPointsX = pdfWidth / EDITOR_PAGE_WIDTH_PX;
        const pxToPointsY = pdfHeight / EDITOR_PAGE_HEIGHT_PX;

        const bandInsetXPts = EDITOR_SAFE_MARGIN_PX * pxToPointsX;
        const bandWidthPts =
          (EDITOR_PAGE_WIDTH_PX - EDITOR_SAFE_MARGIN_PX * 2) * pxToPointsX;
        const bandHeightPts = BACK_COVER_BRAND_BAND_PX * pxToPointsY;
        const bandBottomMarginPts = EDITOR_SAFE_MARGIN_PX * pxToPointsY;

        const bandX = pdfX + bandInsetXPts;
        const bandY = pdfY + bandBottomMarginPts;

        // Opaque fill covers any user content that falls inside the band,
        // matching the editor canvas where the same strip hides content.
        page.drawRectangle({
          x: bandX,
          y: bandY,
          width: bandWidthPts,
          height: bandHeightPts,
          color: rgb(0.961, 0.961, 0.957), // #f5f5f4
        });

        // Thin divider line along the top edge of the band (matches editor).
        page.drawRectangle({
          x: bandX,
          y: bandY + bandHeightPts - 1,
          width: bandWidthPts,
          height: 1,
          color: rgb(0.839, 0.827, 0.82), // #d6d3d1
        });

        // Font sized to fit comfortably inside the band (≈40% of band height).
        const brandFontSize = bandHeightPts * 0.4;
        const brandTextWidth = brandFont.widthOfTextAtSize(
          BACK_COVER_BRAND_TEXT,
          brandFontSize
        );
        const brandTextHeight = brandFont.heightAtSize(brandFontSize);
        const brandX = pdfX + (pdfWidth - brandTextWidth) / 2;
        // Vertically center the glyphs within the reserved band.
        const brandBandCenterY = bandY + bandHeightPts / 2;
        const brandY = brandBandCenterY - brandTextHeight / 2;

        page.drawText(BACK_COVER_BRAND_TEXT, {
          x: brandX,
          y: brandY,
          size: brandFontSize,
          font: brandFont,
          color: rgb(0.27, 0.25, 0.24),
        });
      }
    }

    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = Buffer.from(pdfBytes);

    const pdfS3Key = buildPdfKey(submission.userId, submissionId);
    await uploadToS3(pdfS3Key, pdfBuffer, "application/pdf");

    await prisma.submission.update({
      where: { id: submissionId },
      data: {
        pdfS3Key,
        status: SubmissionStatus.PENDING,
      },
    });

    return pdfS3Key;
  } catch (error) {
    await prisma.submission
      .update({
        where: { id: submissionId },
        data: { status: SubmissionStatus.FAILED },
      })
      .catch(() => undefined);

    throw error;
  }
}
