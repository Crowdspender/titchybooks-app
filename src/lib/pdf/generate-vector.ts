import { PDFDocument, rgb } from "pdf-lib";
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
import { renderSceneToPdfPage } from "./vector-render";
import {
  PANELS,
  mmToPoints,
  A4_LANDSCAPE_WIDTH_MM,
  A4_LANDSCAPE_HEIGHT_MM,
} from "./layout";

interface AssetSource {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Generate the Titchybooks PDF using the vector rendering pipeline.
 *
 * Unlike the raster pipeline (which goes through SVG→sharp→PNG), this
 * renders text elements directly onto pdf-lib pages, producing sharper
 * text at any zoom level and smaller file sizes.
 *
 * Images are still pre-cropped via sharp before embedding.
 */
export async function generateTitchybookPdfVector(
  submissionId: string,
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

    if (submission.mode !== SubmissionMode.EDITOR) {
      throw new Error(
        "Vector rendering is only supported for editor-mode submissions",
      );
    }

    // Build merged scenes (template + user elements)
    const pageMap = new Map(
      submission.pages.map((page) => [page.pageLabel, page]),
    );

    const templateElementsByPage: Map<
      string,
      Array<{ order: number; elementJson: string }>
    > = new Map();
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
      const pageTemplateElements =
        templateElementsByPage.get(page.pageLabel) ?? [];
      if (pageTemplateElements.length > 0) {
        const parsedTemplateElements = pageTemplateElements.map((te) =>
          JSON.parse(te.elementJson) as import("@/lib/editor/schema").EditorElement,
        );
        const textOverrides = userScene.templateTextOverrides ?? {};
        const templateElementsWithOverrides = parsedTemplateElements.map(
          (el) =>
            el.type === "text" && textOverrides[el.id] !== undefined
              ? { ...el, text: textOverrides[el.id] }
              : el,
        );
        return {
          pageLabel: page.pageLabel,
          scene: {
            ...userScene,
            elements: [...templateElementsWithOverrides, ...userScene.elements],
          },
        };
      }
      return { pageLabel: page.pageLabel, scene: userScene };
    });

    // Collect and download all referenced assets
    const assetIds = Array.from(
      new Set(
        scenes.flatMap(({ scene }) =>
          scene.elements
            .filter((el) => el.type === "image")
            .map((el) => el.assetId),
        ),
      ),
    );

    const assets = await prisma.asset.findMany({
      where: { id: { in: assetIds } },
    });

    const assetBufferEntries = await Promise.all(
      assets.map(async (asset) => {
        const buffer = await downloadFromS3(asset.s3Key);
        return [
          asset.id,
          {
            buffer,
            mimeType: asset.mimeType,
            width: asset.width ?? 1,
            height: asset.height ?? 1,
          },
        ] as const;
      }),
    );
    const assetMap = new Map<string, AssetSource>(assetBufferEntries);

    // Create the final imposition sheet
    const finalPdf = await PDFDocument.create();
    const pageWidthPts = mmToPoints(A4_LANDSCAPE_WIDTH_MM);
    const pageHeightPts = mmToPoints(A4_LANDSCAPE_HEIGHT_MM);
    const impositionPage = finalPdf.addPage([pageWidthPts, pageHeightPts]);
    const brandFont = await finalPdf.embedFont(
      (await import("pdf-lib")).StandardFonts.HelveticaBold,
    );

    // Render each panel and embed onto the imposition sheet
    for (const panel of PANELS) {
      const pageRecord = pageMap.get(panel.pageLabel);
      if (!pageRecord) {
        throw new Error(`Missing editor page for panel: ${panel.pageLabel}`);
      }

      const sceneEntry = scenes.find((s) => s.pageLabel === panel.pageLabel);
      if (!sceneEntry) {
        throw new Error(`Missing merged scene for panel: ${panel.pageLabel}`);
      }

      const panelWidthPts = mmToPoints(panel.width);
      const panelHeightPts = mmToPoints(panel.height);

      // Render the scene to its own temporary PDF
      const { pdfDoc: panelPdf } = await renderSceneToPdfPage(
        sceneEntry.scene,
        panelWidthPts,
        panelHeightPts,
        assetMap,
        panel.rotation,
      );

      // Embed the rendered panel PDF into the final imposition sheet
      const panelBytes = await panelPdf.save();
      const [embeddedPage] = await finalPdf.embedPdf(panelBytes);

      // Calculate position on the imposition sheet
      const pdfX = mmToPoints(panel.x);
      const pdfY = mmToPoints(
        A4_LANDSCAPE_HEIGHT_MM - panel.y - panel.height,
      );

      // Draw the embedded page at the correct position
      impositionPage.drawPage(embeddedPage, {
        x: pdfX,
        y: pdfY,
        xScale: 1,
        yScale: 1,
      });

      // Back cover branding (same as raster pipeline)
      if (panel.pageLabel === "BACK_COVER") {
        const pxToPointsX = panelWidthPts / EDITOR_PAGE_WIDTH_PX;
        const pxToPointsY = panelHeightPts / EDITOR_PAGE_HEIGHT_PX;

        const bandInsetXPts = EDITOR_SAFE_MARGIN_PX * pxToPointsX;
        const bandWidthPts =
          (EDITOR_PAGE_WIDTH_PX - EDITOR_SAFE_MARGIN_PX * 2) * pxToPointsX;
        const bandHeightPts = BACK_COVER_BRAND_BAND_PX * pxToPointsY;
        const bandBottomMarginPts = EDITOR_SAFE_MARGIN_PX * pxToPointsY;

        const bandX = pdfX + bandInsetXPts;
        const bandY = pdfY + bandBottomMarginPts;

        impositionPage.drawRectangle({
          x: bandX,
          y: bandY,
          width: bandWidthPts,
          height: bandHeightPts,
          color: rgb(0.961, 0.961, 0.957),
        });

        impositionPage.drawRectangle({
          x: bandX,
          y: bandY + bandHeightPts - 1,
          width: bandWidthPts,
          height: 1,
          color: rgb(0.839, 0.827, 0.82),
        });

        const brandFontSize = bandHeightPts * 0.4;
        const brandTextWidth = brandFont.widthOfTextAtSize(
          BACK_COVER_BRAND_TEXT,
          brandFontSize,
        );
        const brandTextHeight = brandFont.heightAtSize(brandFontSize);
        const brandX = pdfX + (panelWidthPts - brandTextWidth) / 2;
        const brandBandCenterY = bandY + bandHeightPts / 2;
        const brandY = brandBandCenterY - brandTextHeight / 2;

        impositionPage.drawText(BACK_COVER_BRAND_TEXT, {
          x: brandX,
          y: brandY,
          size: brandFontSize,
          font: brandFont,
          color: rgb(0.27, 0.25, 0.24),
        });
      }
    }

    const pdfBytes = await finalPdf.save();
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
