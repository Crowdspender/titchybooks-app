import { EDITOR_SAFE_MARGIN_PX } from "./constants";
import { layoutDesignText } from "./design-text-layout";
import type { EditorScene } from "./schema";

export interface ThumbnailAsset {
  id: string;
  previewUrl: string | null;
  downloadUrl: string | null;
}

/**
 * Client-side canvas rendering of a design-resolved page scene, shared by
 * the editor filmstrip thumbnails and the booklet preview. Returns a PNG
 * data URL, or null when the scene cannot be drawn (e.g. unqualified fonts
 * or a missing 2D context).
 */
export function renderPageThumbnail(
  renderScene: EditorScene,
  assets: ThumbnailAsset[],
  thumbnailWidth: number,
): string | null {
  const canvas = document.createElement("canvas");
  const thumbnailHeight = (thumbnailWidth / renderScene.page.widthPx) *
    renderScene.page.heightPx;
  canvas.width = thumbnailWidth;
  canvas.height = thumbnailHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Fill background
  ctx.fillStyle = renderScene.page.backgroundColor;
  ctx.fillRect(0, 0, thumbnailWidth, thumbnailHeight);

  // Draw safe margin
  const safeMargin = (EDITOR_SAFE_MARGIN_PX / renderScene.page.widthPx) *
    thumbnailWidth;
  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(
    safeMargin,
    safeMargin,
    thumbnailWidth - safeMargin * 2,
    thumbnailHeight - safeMargin * 2,
  );
  ctx.setLineDash([]);

  // Draw elements (simplified for thumbnail)
  const scale = thumbnailWidth / renderScene.page.widthPx;
  const sortedElements = renderScene.elements.slice().sort((left, right) =>
    left.zIndex - right.zIndex
  );

  for (const element of sortedElements) {
    if (!element.visible) continue;

    ctx.save();
    ctx.globalAlpha = element.opacity;
    if (element.type === "text" && element.typographyVersion) {
      try {
        ctx.translate(element.x * scale, element.y * scale);
        ctx.rotate(element.rotation * Math.PI / 180);
        ctx.scale(scale, scale);
        ctx.fillStyle = element.color;
        ctx.fill(new Path2D(layoutDesignText(element).path));
      } catch {
        return null;
      }
      ctx.restore();
      continue;
    }
    const centerX = (element.x + element.width / 2) * scale;
    const centerY = (element.y + element.height / 2) * scale;
    ctx.translate(centerX, centerY);
    ctx.rotate((element.rotation * Math.PI) / 180);

    if (element.type === "shape") {
      ctx.fillStyle = element.fill;
      if (element.shape === "rect") {
        ctx.fillRect(
          -element.width * scale / 2,
          -element.height * scale / 2,
          element.width * scale,
          element.height * scale,
        );
      } else if (element.shape === "circle") {
        ctx.beginPath();
        ctx.arc(
          0,
          0,
          Math.min(element.width, element.height) * scale / 2,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      } else if (element.shape === "line") {
        ctx.strokeStyle = element.stroke || element.fill;
        ctx.lineWidth = (element.strokeWidth || 2) * scale;
        ctx.beginPath();
        ctx.moveTo(-element.width * scale / 2, -element.height * scale / 2);
        ctx.lineTo(element.width * scale / 2, element.height * scale / 2);
        ctx.stroke();
      }
    } else if (element.type === "text") {
      ctx.fillStyle = element.color;
      ctx.font = `${element.fontWeight >= 600 ? "bold" : "normal"} ${
        element.fontSize * scale
      }px ${element.fontFamily}`;
      ctx.textAlign = element.align === "center"
        ? "center"
        : element.align === "right"
        ? "right"
        : "left";
      ctx.textBaseline = "top";

      const boxWidth = element.width * scale;
      const boxHeight = element.height * scale;
      const lineHeight = element.fontSize * element.lineHeight * scale;
      const textX = element.align === "center"
        ? 0
        : element.align === "right"
        ? boxWidth / 2
        : -boxWidth / 2;

      // Word-wrap to match the canvas/PDF behavior using actual font metrics
      const wrappedLines: string[] = [];
      for (const paragraph of element.text.split(/\r?\n/)) {
        const trimmed = paragraph.trimEnd();
        if (trimmed === "") {
          wrappedLines.push("");
          continue;
        }
        const words = trimmed.split(" ");
        let currentLine = "";
        for (const word of words) {
          const candidate = currentLine === ""
            ? word
            : `${currentLine} ${word}`;
          if (
            ctx.measureText(candidate).width > boxWidth && currentLine !== ""
          ) {
            wrappedLines.push(currentLine);
            currentLine = word;
          } else {
            currentLine = candidate;
          }
        }
        if (currentLine !== "") {
          wrappedLines.push(currentLine);
        }
      }

      // Clip to box bounds so overflowing text doesn't bleed past the frame
      ctx.save();
      ctx.beginPath();
      ctx.rect(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight);
      ctx.clip();

      wrappedLines.forEach((line, i) => {
        ctx.fillText(line, textX, -boxHeight / 2 + i * lineHeight);
      });

      ctx.restore();
    } else if (element.type === "image") {
      const asset = assets.find((a) => a.id === element.assetId);
      if (asset?.previewUrl || asset?.downloadUrl) {
        const img = new window.Image();
        img.crossOrigin = "anonymous";
        img.src = asset.previewUrl || asset.downloadUrl || "";
        // Draw synchronously if cached, otherwise skip for thumbnail
        if (img.complete && img.naturalWidth > 0) {
          ctx.drawImage(
            img,
            -element.width * scale / 2,
            -element.height * scale / 2,
            element.width * scale,
            element.height * scale,
          );
        }
      } else {
        // Placeholder for missing image
        ctx.fillStyle = "#e5e7eb";
        ctx.fillRect(
          -element.width * scale / 2,
          -element.height * scale / 2,
          element.width * scale,
          element.height * scale,
        );
        ctx.fillStyle = "#9ca3af";
        ctx.font = `${10 * scale}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Image", 0, 0);
      }
    }

    ctx.restore();
  }

  return canvas.toDataURL("image/png", 0.7);
}