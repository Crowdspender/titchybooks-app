import type { EditorElement } from "@/lib/editor/schema";

interface CropRectOptions {
  imageWidth: number;
  imageHeight: number;
  frameWidth: number;
  frameHeight: number;
  crop: Extract<EditorElement, { type: "image" }>["crop"];
}

export interface ImageCropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getNormalizedCropValue(value: number): number {
  return clamp(value, -1, 1);
}

export function getNormalizedZoomValue(value: number): number {
  return clamp(value, 1, 4);
}

export function getImageCropRect({
  imageWidth,
  imageHeight,
  frameWidth,
  frameHeight,
  crop,
}: CropRectOptions): ImageCropRect {
  if (imageWidth <= 0 || imageHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) {
    return {
      x: 0,
      y: 0,
      width: Math.max(imageWidth, 1),
      height: Math.max(imageHeight, 1),
    };
  }

  const frameAspectRatio = frameWidth / frameHeight;
  const imageAspectRatio = imageWidth / imageHeight;

  let baseWidth = imageWidth;
  let baseHeight = imageHeight;

  if (imageAspectRatio > frameAspectRatio) {
    baseWidth = imageHeight * frameAspectRatio;
  } else {
    baseHeight = imageWidth / frameAspectRatio;
  }

  const zoom = getNormalizedZoomValue(Math.max(crop.scaleX, crop.scaleY));
  const cropWidth = baseWidth / zoom;
  const cropHeight = baseHeight / zoom;
  const maxOffsetX = (imageWidth - cropWidth) / 2;
  const maxOffsetY = (imageHeight - cropHeight) / 2;
  const normalizedX = getNormalizedCropValue(crop.x);
  const normalizedY = getNormalizedCropValue(crop.y);
  const centerX = imageWidth / 2 + normalizedX * maxOffsetX;
  const centerY = imageHeight / 2 + normalizedY * maxOffsetY;

  return {
    x: clamp(centerX - cropWidth / 2, 0, imageWidth - cropWidth),
    y: clamp(centerY - cropHeight / 2, 0, imageHeight - cropHeight),
    width: cropWidth,
    height: cropHeight,
  };
}
