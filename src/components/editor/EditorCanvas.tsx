"use client";

import { useEffect, useRef, useState } from "react";
import {
  Circle,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer,
} from "react-konva";
import type Konva from "konva";
import { getImageCropRect, getNormalizedZoomValue } from "@/lib/editor/crop";
import type { EditorElement, EditorScene } from "@/lib/editor/schema";
import {
  BACK_COVER_BRAND_BAND_PX,
  BACK_COVER_BRAND_TEXT,
  EDITOR_SAFE_MARGIN_PX,
} from "@/lib/editor/constants";
import type { PageLabel } from "@/lib/constants";

interface CanvasAsset {
  id: string;
  previewUrl: string | null;
  downloadUrl: string | null;
  width: number | null;
  height: number | null;
}

interface EditorCanvasProps {
  scene: EditorScene;
  assets: CanvasAsset[];
  selectedElementId: string | null;
  onSelectElement: (elementId: string | null) => void;
  onSceneChange: (scene: EditorScene) => void;
  pageLabel?: PageLabel;
  templateElementIds?: Set<string>;
  /** IDs of template elements whose text content is user-editable. */
  templateTextElementIds?: Set<string>;
  isInstanceMode?: boolean;
}

const CANVAS_MAX_WIDTH_PX = 420;

function useCanvasImage(src: string | null) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!src) {
      return;
    }

    const nextImage = new window.Image();
    nextImage.crossOrigin = "anonymous";
    nextImage.onload = () => setImage(nextImage);
    nextImage.src = src;

    return () => {
      nextImage.onload = null;
    };
  }, [src]);

  return src ? image : null;
}

function CanvasImageElement({
  element,
  src,
  scale,
  isSelected,
  onSelect,
  onDragEnd,
  onTransformEnd,
  onEnterCropMode,
}: {
  element: Extract<EditorElement, { type: "image" }>;
  src: string | null;
  scale: number;
  isSelected: boolean;
  onSelect: () => void;
  onDragEnd: (position: { x: number; y: number }) => void;
  onTransformEnd: (next: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  }) => void;
  onEnterCropMode: () => void;
}) {
  const image = useCanvasImage(src);
  const nodeRef = useRef<Konva.Image | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const cropRect = image && image.naturalWidth > 0 && image.naturalHeight > 0
    ? getImageCropRect({
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      frameWidth: element.width,
      frameHeight: element.height,
      crop: element.crop,
    })
    : null;

  useEffect(() => {
    if (!isSelected || !nodeRef.current || !transformerRef.current) {
      return;
    }

    transformerRef.current.nodes([nodeRef.current]);
    transformerRef.current.getLayer()?.batchDraw();
  }, [isSelected]);

  return (
    <>
      <KonvaImage
        ref={nodeRef}
        image={image ?? undefined}
        x={element.x * scale}
        y={element.y * scale}
        width={element.width * scale}
        height={element.height * scale}
        rotation={element.rotation}
        opacity={element.opacity}
        cornerRadius={element.cornerRadius}
        crop={cropRect
          ? {
            x: cropRect.x,
            y: cropRect.y,
            width: cropRect.width,
            height: cropRect.height,
          }
          : undefined}
        draggable={!element.locked}
        visible={element.visible}
        onClick={onSelect}
        onTap={onSelect}
        onDblClick={onEnterCropMode}
        onDblTap={onEnterCropMode}
        onDragEnd={(event) => {
          onDragEnd({
            x: event.target.x() / scale,
            y: event.target.y() / scale,
          });
        }}
        onTransformEnd={(event) => {
          const node = event.target as Konva.Image;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();

          node.scaleX(1);
          node.scaleY(1);

          onTransformEnd({
            x: node.x() / scale,
            y: node.y() / scale,
            width: (node.width() * scaleX) / scale,
            height: (node.height() * scaleY) / scale,
            rotation: node.rotation(),
          });
        }}
      />
      {isSelected
        ? (
          <Transformer
            ref={transformerRef}
            rotateEnabled
            enabledAnchors={[
              "top-left",
              "top-right",
              "bottom-left",
              "bottom-right",
            ]}
            boundBoxFunc={(_oldBox, newBox) => {
              if (newBox.width < 20 || newBox.height < 20) {
                return _oldBox;
              }
              return newBox;
            }}
          />
        )
        : null}
    </>
  );
}

function CanvasTextElement({
  element,
  scale,
  isSelected,
  onSelect,
  onDragEnd,
  onTransformEnd,
}: {
  element: Extract<EditorElement, { type: "text" }>;
  scale: number;
  isSelected: boolean;
  onSelect: () => void;
  onDragEnd: (position: { x: number; y: number }) => void;
  onTransformEnd: (next: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  }) => void;
}) {
  const nodeRef = useRef<Konva.Text | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);

  useEffect(() => {
    if (!isSelected || !nodeRef.current || !transformerRef.current) {
      return;
    }

    transformerRef.current.nodes([nodeRef.current]);
    transformerRef.current.getLayer()?.batchDraw();
  }, [isSelected]);

  return (
    <>
      <Text
        ref={nodeRef}
        x={element.x * scale}
        y={element.y * scale}
        width={element.width * scale}
        height={element.height * scale}
        rotation={element.rotation}
        opacity={element.opacity}
        text={element.text}
        fontFamily={element.fontFamily}
        fontSize={element.fontSize * scale}
        fontStyle={element.fontWeight >= 600 ? "bold" : "normal"}
        lineHeight={element.lineHeight}
        letterSpacing={element.letterSpacing * scale}
        fill={element.color}
        align={element.align}
        verticalAlign={element.verticalAlign}
        wrap="word"
        draggable={!element.locked}
        visible={element.visible}
        onClick={onSelect}
        onTap={onSelect}
        onDragEnd={(event) => {
          onDragEnd({
            x: event.target.x() / scale,
            y: event.target.y() / scale,
          });
        }}
        onTransformEnd={(event) => {
          const node = event.target as Konva.Text;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();

          node.scaleX(1);
          node.scaleY(1);

          onTransformEnd({
            x: node.x() / scale,
            y: node.y() / scale,
            width: (node.width() * scaleX) / scale,
            height: (node.height() * scaleY) / scale,
            rotation: node.rotation(),
          });
        }}
      />
      {isSelected
        ? (
          <Transformer
            ref={transformerRef}
            rotateEnabled
            keepRatio={false}
            enabledAnchors={[
              "top-left",
              "top-center",
              "top-right",
              "middle-left",
              "middle-right",
              "bottom-left",
              "bottom-center",
              "bottom-right",
            ]}
            boundBoxFunc={(oldBox, newBox) => {
              if (newBox.width < 40 || newBox.height < 24) {
                return oldBox;
              }
              return newBox;
            }}
          />
        )
        : null}
    </>
  );
}

function CanvasShapeElement({
  element,
  scale,
  isSelected,
  onSelect,
  onDragEnd,
  onTransformEnd,
}: {
  element: Extract<EditorElement, { type: "shape" }>;
  scale: number;
  isSelected: boolean;
  onSelect: () => void;
  onDragEnd: (position: { x: number; y: number }) => void;
  onTransformEnd: (next: {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
  }) => void;
}) {
  const nodeRef = useRef<Konva.Shape | null>(null);
  const setNodeRef = (node: Konva.Shape | null) => {
    nodeRef.current = node;
  };
  const transformerRef = useRef<Konva.Transformer | null>(null);

  useEffect(() => {
    if (!isSelected || !nodeRef.current || !transformerRef.current) {
      return;
    }

    transformerRef.current.nodes([nodeRef.current]);
    transformerRef.current.getLayer()?.batchDraw();
  }, [isSelected]);

  const commonProps = {
    x: element.x * scale,
    y: element.y * scale,
    rotation: element.rotation,
    opacity: element.opacity,
    draggable: !element.locked,
    visible: element.visible,
    onClick: onSelect,
    onTap: onSelect,
    onDragEnd: (event: Konva.KonvaEventObject<DragEvent>) => {
      onDragEnd({
        x: event.target.x() / scale,
        y: event.target.y() / scale,
      });
    },
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => {
      const node = event.target as Konva.Shape;
      const scaleX = node.scaleX();
      const scaleY = node.scaleY();

      node.scaleX(1);
      node.scaleY(1);

      onTransformEnd({
        x: node.x() / scale,
        y: node.y() / scale,
        width: Math.max(20, (node.width() * scaleX) / scale),
        height: Math.max(2, (node.height() * scaleY) / scale),
        rotation: node.rotation(),
      });
    },
  };

  if (element.shape === "circle") {
    const radius = Math.min(element.width, element.height) / 2;
    return (
      <>
        <Circle
          ref={setNodeRef}
          {...commonProps}
          x={element.x * scale + radius * scale}
          y={element.y * scale + radius * scale}
          radius={radius * scale}
          fill={element.fill}
          stroke={element.stroke}
          strokeWidth={(element.strokeWidth ?? 0) * scale}
          // Override onDragEnd to account for center-offset positioning
          onDragEnd={(event) => {
            onDragEnd({
              x: event.target.x() / scale - radius,
              y: event.target.y() / scale - radius,
            });
          }}
          onTransformEnd={(event) => {
            const node = event.target as Konva.Shape;
            const scaleX = node.scaleX();
            const scaleY = node.scaleY();
            node.scaleX(1);
            node.scaleY(1);
            const newRadius = radius * Math.max(scaleX, scaleY);
            const newDiameter = newRadius * 2;
            onTransformEnd({
              x: node.x() / scale - newRadius,
              y: node.y() / scale - newRadius,
              width: newDiameter,
              height: newDiameter,
              rotation: node.rotation(),
            });
          }}
        />
        {isSelected
          ? (
            <Transformer
              ref={transformerRef}
              rotateEnabled
              enabledAnchors={[
                "top-left",
                "top-right",
                "bottom-left",
                "bottom-right",
              ]}
              boundBoxFunc={(_oldBox, newBox) => {
                if (newBox.width < 20 || newBox.height < 20) {
                  return _oldBox;
                }
                return newBox;
              }}
            />
          )
          : null}
      </>
    );
  }

  if (element.shape === "line") {
    return (
      <>
        <Line
          ref={setNodeRef}
          {...commonProps}
          points={[
            0,
            0,
            element.width * scale,
            0, // Always horizontal — strokeWidth controls visual thickness
          ]}
          stroke={element.stroke ?? element.fill}
          strokeWidth={(element.strokeWidth ?? 2) * scale}
        />
        {isSelected
          ? (
            <Transformer
              ref={transformerRef}
              rotateEnabled
              enabledAnchors={["top-left", "bottom-right"]}
              boundBoxFunc={(_oldBox, newBox) => {
                if (newBox.width < 20) {
                  return _oldBox;
                }
                return newBox;
              }}
            />
          )
          : null}
      </>
    );
  }

  // Rectangle (default)
  return (
    <>
      <Rect
        ref={setNodeRef}
        {...commonProps}
        width={element.width * scale}
        height={element.height * scale}
        fill={element.fill}
        stroke={element.stroke}
        strokeWidth={(element.strokeWidth ?? 0) * scale}
      />
      {isSelected
        ? (
          <Transformer
            ref={transformerRef}
            rotateEnabled
            keepRatio={false}
            enabledAnchors={[
              "top-left",
              "top-center",
              "top-right",
              "middle-left",
              "middle-right",
              "bottom-left",
              "bottom-center",
              "bottom-right",
            ]}
            boundBoxFunc={(_oldBox, newBox) => {
              if (newBox.width < 20 || newBox.height < 20) {
                return _oldBox;
              }
              return newBox;
            }}
          />
        )
        : null}
    </>
  );
}

function CanvasImageCropOverlay({
  element,
  src,
  scale,
  onUpdateCrop,
}: {
  element: Extract<EditorElement, { type: "image" }>;
  src: string | null;
  scale: number;
  onUpdateCrop: (nextCrop: { x: number; y: number }) => void;
}) {
  const image = useCanvasImage(src);
  const dimImageRef = useRef<Konva.Image | null>(null);

  if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return (
      <Rect
        x={element.x * scale}
        y={element.y * scale}
        width={element.width * scale}
        height={element.height * scale}
        rotation={element.rotation}
        stroke="#3b82f6"
        dash={[6, 4]}
        strokeWidth={2}
        listening={false}
      />
    );
  }

  const imageWidth = image.naturalWidth;
  const imageHeight = image.naturalHeight;
  const frameWidth = element.width;
  const frameHeight = element.height;

  const cropRect = getImageCropRect({
    imageWidth,
    imageHeight,
    frameWidth,
    frameHeight,
    crop: element.crop,
  });

  // scene-pixels per image-pixel: the full image is scaled so that the
  // current crop window exactly covers the frame.
  const scaleFactor = frameWidth / cropRect.width;
  const displayWidth = imageWidth * scaleFactor;
  const displayHeight = imageHeight * scaleFactor;
  const imageOffsetX = -cropRect.x * scaleFactor;
  const imageOffsetY = -cropRect.y * scaleFactor;

  // Recompute base cover-fit dimensions and max focal-point offsets (in image
  // pixels) so drag positions can be inverted back into normalized crop.x/y.
  const frameAspect = frameWidth / frameHeight;
  const imageAspect = imageWidth / imageHeight;
  let baseWidth = imageWidth;
  let baseHeight = imageHeight;
  if (imageAspect > frameAspect) {
    baseWidth = imageHeight * frameAspect;
  } else {
    baseHeight = imageWidth / frameAspect;
  }
  const zoom = getNormalizedZoomValue(
    Math.max(element.crop.scaleX, element.crop.scaleY),
  );
  const cropWindowWidth = baseWidth / zoom;
  const cropWindowHeight = baseHeight / zoom;
  const maxOffsetX = (imageWidth - cropWindowWidth) / 2;
  const maxOffsetY = (imageHeight - cropWindowHeight) / 2;

  // Canvas-pixel drag bounds: keep the full image covering the frame.
  const minCanvasX = (frameWidth - displayWidth) * scale;
  const minCanvasY = (frameHeight - displayHeight) * scale;

  function computeCropFromSceneOffset(sceneX: number, sceneY: number) {
    const newCropX = -sceneX / scaleFactor;
    const newCropY = -sceneY / scaleFactor;
    const clampedX = Math.max(
      0,
      Math.min(imageWidth - cropWindowWidth, newCropX),
    );
    const clampedY = Math.max(
      0,
      Math.min(imageHeight - cropWindowHeight, newCropY),
    );
    const centerX = clampedX + cropWindowWidth / 2;
    const centerY = clampedY + cropWindowHeight / 2;
    const normalizedX = maxOffsetX > 0
      ? (centerX - imageWidth / 2) / maxOffsetX
      : 0;
    const normalizedY = maxOffsetY > 0
      ? (centerY - imageHeight / 2) / maxOffsetY
      : 0;
    return {
      x: Math.max(-1, Math.min(1, normalizedX)),
      y: Math.max(-1, Math.min(1, normalizedY)),
    };
  }

  return (
    <>
      {/* Dimmed full image — shows the portions that are currently cropped out. */}
      <Group
        x={element.x * scale}
        y={element.y * scale}
        rotation={element.rotation}
        listening={false}
      >
        <KonvaImage
          ref={dimImageRef}
          image={image}
          x={imageOffsetX * scale}
          y={imageOffsetY * scale}
          width={displayWidth * scale}
          height={displayHeight * scale}
          opacity={0.35}
          listening={false}
        />
      </Group>

      {/* Full-opacity image clipped to the frame — this is the draggable pan target. */}
      <Group
        x={element.x * scale}
        y={element.y * scale}
        rotation={element.rotation}
        clipFunc={(ctx) => {
          ctx.rect(0, 0, element.width * scale, element.height * scale);
        }}
      >
        <KonvaImage
          image={image}
          x={imageOffsetX * scale}
          y={imageOffsetY * scale}
          width={displayWidth * scale}
          height={displayHeight * scale}
          draggable
          dragBoundFunc={(pos) => ({
            x: Math.min(0, Math.max(minCanvasX, pos.x)),
            y: Math.min(0, Math.max(minCanvasY, pos.y)),
          })}
          onDragMove={(event) => {
            // Keep the dimmed preview in sync while dragging.
            if (dimImageRef.current) {
              dimImageRef.current.x(event.target.x());
              dimImageRef.current.y(event.target.y());
              dimImageRef.current.getLayer()?.batchDraw();
            }
          }}
          onDragEnd={(event) => {
            const sceneOffX = event.target.x() / scale;
            const sceneOffY = event.target.y() / scale;
            onUpdateCrop(computeCropFromSceneOffset(sceneOffX, sceneOffY));
          }}
        />
      </Group>

      {/* Crop frame outline (dashed blue) — non-interactive marker. */}
      <Rect
        x={element.x * scale}
        y={element.y * scale}
        width={element.width * scale}
        height={element.height * scale}
        rotation={element.rotation}
        stroke="#3b82f6"
        dash={[6, 4]}
        strokeWidth={2}
        listening={false}
      />

      {/* Corner markers for clearer visual affordance. */}
      {[
        [0, 0],
        [element.width, 0],
        [0, element.height],
        [element.width, element.height],
      ].map(([cx, cy], index) => (
        <Rect
          key={index}
          x={(element.x + cx) * scale - 5}
          y={(element.y + cy) * scale - 5}
          width={10}
          height={10}
          fill="#ffffff"
          stroke="#3b82f6"
          strokeWidth={2}
          rotation={element.rotation}
          listening={false}
        />
      ))}
    </>
  );
}

function setCursorStyle(e: Konva.KonvaEventObject<Event>, cursor: string) {
  const container = e.target.getStage()?.container();
  if (container) container.style.cursor = cursor;
}

/**
 * TemplateLayerElement renders a template element in instance mode with
 * all interactions disabled. Shows a not-allowed cursor on hover.
 *
 * Exception: template TEXT elements can be selected so their text content
 * (and only their text content) can be edited via the properties panel.
 * Position, size, font, and styling of text elements remain fixed.
 */
function TemplateLayerElement({
  element,
  scale,
  assetMap,
  isTextEditable = false,
  isSelected = false,
  onSelect,
}: {
  element: EditorElement;
  scale: number;
  assetMap: Map<string, CanvasAsset>;
  isTextEditable?: boolean;
  isSelected?: boolean;
  onSelect?: () => void;
}) {
  if (element.type === "image") {
    const imageSrc = assetMap.get(element.assetId)?.previewUrl ??
      assetMap.get(element.assetId)?.downloadUrl ??
      null;
    return (
      <TemplateImageElement
        element={element}
        src={imageSrc}
        scale={scale}
      />
    );
  }

  if (element.type === "text") {
    const editable = isTextEditable;
    return (
      <>
        <Text
          x={element.x * scale}
          y={element.y * scale}
          width={element.width * scale}
          height={element.height * scale}
          rotation={element.rotation}
          opacity={element.opacity}
          text={element.text}
          fontFamily={element.fontFamily}
          fontSize={element.fontSize * scale}
          fontStyle={element.fontWeight >= 600 ? "bold" : "normal"}
          lineHeight={element.lineHeight}
          letterSpacing={element.letterSpacing * scale}
          fill={element.color}
          align={element.align}
          verticalAlign={element.verticalAlign}
          wrap="word"
          visible={element.visible}
          listening={true}
          onMouseEnter={(e) =>
            setCursorStyle(e, editable ? "text" : "not-allowed")}
          onMouseLeave={(e) => setCursorStyle(e, "default")}
          onClick={editable ? onSelect : () => {/* blocked */}}
          onTap={editable ? onSelect : undefined}
          onDblClick={editable ? onSelect : undefined}
          onDblTap={editable ? onSelect : undefined}
        />
        {editable && isSelected
          ? (
            <Rect
              x={element.x * scale}
              y={element.y * scale}
              width={element.width * scale}
              height={element.height * scale}
              rotation={element.rotation}
              stroke="#3b82f6"
              dash={[6, 4]}
              strokeWidth={1.5}
              listening={false}
            />
          )
          : null}
      </>
    );
  }

  if (element.type === "shape") {
    if (element.shape === "circle") {
      const radius = Math.min(element.width, element.height) / 2;
      return (
        <Circle
          x={element.x * scale + radius * scale}
          y={element.y * scale + radius * scale}
          radius={radius * scale}
          rotation={element.rotation}
          opacity={element.opacity}
          fill={element.fill}
          stroke={element.stroke}
          strokeWidth={(element.strokeWidth ?? 0) * scale}
          visible={element.visible}
          listening={true}
          onMouseEnter={(e) => setCursorStyle(e, "not-allowed")}
          onMouseLeave={(e) => setCursorStyle(e, "default")}
          onClick={() => {/* blocked */}}
        />
      );
    }

    if (element.shape === "line") {
      return (
        <Line
          x={element.x * scale}
          y={element.y * scale}
          points={[0, 0, element.width * scale, 0]}
          stroke={element.stroke ?? element.fill}
          strokeWidth={(element.strokeWidth ?? 2) * scale}
          rotation={element.rotation}
          opacity={element.opacity}
          visible={element.visible}
          listening={true}
          onMouseEnter={(e) => setCursorStyle(e, "not-allowed")}
          onMouseLeave={(e) => setCursorStyle(e, "default")}
          onClick={() => {/* blocked */}}
        />
      );
    }

    // Rectangle
    return (
      <Rect
        x={element.x * scale}
        y={element.y * scale}
        width={element.width * scale}
        height={element.height * scale}
        rotation={element.rotation}
        opacity={element.opacity}
        fill={element.fill}
        stroke={element.stroke}
        strokeWidth={(element.strokeWidth ?? 0) * scale}
        visible={element.visible}
        listening={true}
        onMouseEnter={(e) => setCursorStyle(e, "not-allowed")}
        onMouseLeave={(e) => setCursorStyle(e, "default")}
        onClick={() => {/* blocked */}}
      />
    );
  }

  return null;
}

/**
 * Separate component for template image elements so useCanvasImage hook
 * is called at the top level of a component.
 */
function TemplateImageElement({
  element,
  src,
  scale,
}: {
  element: Extract<EditorElement, { type: "image" }>;
  src: string | null;
  scale: number;
}) {
  const image = useCanvasImage(src);
  return (
    <KonvaImage
      image={image ?? undefined}
      x={element.x * scale}
      y={element.y * scale}
      width={element.width * scale}
      height={element.height * scale}
      rotation={element.rotation}
      opacity={element.opacity}
      visible={element.visible}
      listening={true}
      onMouseEnter={(e) => setCursorStyle(e, "not-allowed")}
      onMouseLeave={(e) => setCursorStyle(e, "default")}
      onClick={() => {/* blocked */}}
    />
  );
}

export default function EditorCanvas({
  scene,
  assets,
  selectedElementId,
  onSelectElement,
  onSceneChange,
  pageLabel,
  templateElementIds = new Set(),
  templateTextElementIds = new Set(),
  isInstanceMode = false,
}: EditorCanvasProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const scale = Math.min(1, CANVAS_MAX_WIDTH_PX / scene.page.widthPx);
  const stageWidth = scene.page.widthPx * scale;
  const stageHeight = scene.page.heightPx * scale;
  const isBackCover = pageLabel === "BACK_COVER";
  const brandBandPx = isBackCover ? BACK_COVER_BRAND_BAND_PX : 0;
  const safeAreaY = EDITOR_SAFE_MARGIN_PX;
  const safeAreaHeight = scene.page.heightPx - EDITOR_SAFE_MARGIN_PX * 2;
  const brandBandY = safeAreaY + safeAreaHeight - brandBandPx;
  const [cropModeId, setCropModeId] = useState<string | null>(null);
  const assetMap = new Map(
    assets.map((asset) => [asset.id, asset]),
  );

  useEffect(() => {
    if (!cropModeId) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setCropModeId(null);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [cropModeId]);

  // Exit crop mode if the crop-target element no longer exists or selection
  // has moved to a different element.
  useEffect(() => {
    if (!cropModeId) {
      return;
    }
    const stillExists = scene.elements.some((element) =>
      element.id === cropModeId && element.type === "image"
    );
    if (!stillExists) {
      setCropModeId(null);
      return;
    }
    if (selectedElementId && selectedElementId !== cropModeId) {
      setCropModeId(null);
    }
  }, [cropModeId, scene.elements, selectedElementId]);

  function updateElement(
    elementId: string,
    updater: (element: EditorElement) => EditorElement,
  ) {
    onSceneChange({
      ...scene,
      elements: scene.elements.map((element) =>
        element.id === elementId ? updater(element) : element
      ),
    });
  }

  return (
    <div className="card p-4" style={{ background: "var(--color-surface)" }}>
      <Stage
        ref={stageRef}
        width={stageWidth}
        height={stageHeight}
        className="mx-auto rounded-xl bg-white"
        style={{ boxShadow: "0 20px 50px rgba(28, 25, 23, 0.12)" }}
        onMouseDown={(event) => {
          if (event.target === event.target.getStage()) {
            onSelectElement(null);
            setCropModeId(null);
          }
        }}
      >
        <Layer>
          <Rect
            x={0}
            y={0}
            width={stageWidth}
            height={stageHeight}
            fill={scene.page.backgroundColor}
          />
          <Rect
            x={EDITOR_SAFE_MARGIN_PX * scale}
            y={safeAreaY * scale}
            width={(scene.page.widthPx - EDITOR_SAFE_MARGIN_PX * 2) * scale}
            height={safeAreaHeight * scale}
            stroke="#f97316"
            dash={[8, 6]}
            strokeWidth={1}
            listening={false}
          />
          {scene.elements
            .slice()
            .sort((left, right) =>
              left.zIndex - right.zIndex
            )
            .map((element) => {
              const isTemplateEl = isInstanceMode &&
                templateElementIds.has(element.id);

              // For template elements in instance mode: render but disable all interactions
              if (isTemplateEl) {
                const isTextEditable = templateTextElementIds.has(element.id);
                return (
                  <TemplateLayerElement
                    key={element.id}
                    element={element}
                    scale={scale}
                    assetMap={assetMap}
                    isTextEditable={isTextEditable}
                    isSelected={selectedElementId === element.id}
                    onSelect={() => onSelectElement(element.id)}
                  />
                );
              }

              // Normal (user) element rendering
              if (element.type === "image") {
                const imageSrc = assetMap.get(element.assetId)?.previewUrl ??
                  assetMap.get(element.assetId)?.downloadUrl ??
                  null;
                if (cropModeId === element.id) {
                  return (
                    <CanvasImageCropOverlay
                      key={element.id}
                      element={element}
                      src={imageSrc}
                      scale={scale}
                      onUpdateCrop={(nextCrop) => {
                        updateElement(element.id, (current) =>
                          current.type === "image"
                            ? {
                              ...current,
                              crop: {
                                ...current.crop,
                                x: nextCrop.x,
                                y: nextCrop.y,
                              },
                            }
                            : current);
                      }}
                    />
                  );
                }
                return (
                  <CanvasImageElement
                    key={element.id}
                    element={element}
                    src={imageSrc}
                    scale={scale}
                    isSelected={selectedElementId === element.id}
                    onSelect={() => onSelectElement(element.id)}
                    onEnterCropMode={() => {
                      onSelectElement(element.id);
                      setCropModeId(element.id);
                    }}
                    onDragEnd={(position) => {
                      updateElement(element.id, (current) => ({
                        ...current,
                        ...position,
                      }));
                    }}
                    onTransformEnd={(next) => {
                      updateElement(element.id, (current) => ({
                        ...current,
                        ...next,
                      }));
                    }}
                  />
                );
              }

              if (element.type === "text") {
                return (
                  <CanvasTextElement
                    key={element.id}
                    element={element}
                    scale={scale}
                    isSelected={selectedElementId === element.id}
                    onSelect={() => onSelectElement(element.id)}
                    onDragEnd={(position) => {
                      updateElement(element.id, (current) => ({
                        ...current,
                        ...position,
                      }));
                    }}
                    onTransformEnd={(next) => {
                      updateElement(element.id, (current) => ({
                        ...current,
                        ...next,
                      }));
                    }}
                  />
                );
              }

              if (element.type === "shape") {
                return (
                  <CanvasShapeElement
                    key={element.id}
                    element={element}
                    scale={scale}
                    isSelected={selectedElementId === element.id}
                    onSelect={() => onSelectElement(element.id)}
                    onDragEnd={(position) => {
                      updateElement(element.id, (current) => ({
                        ...current,
                        ...position,
                      }));
                    }}
                    onTransformEnd={(next) => {
                      updateElement(element.id, (current) => ({
                        ...current,
                        ...next,
                      }));
                    }}
                  />
                );
              }

              return null;
            })}
          {isBackCover
            ? (
              <>
                <Rect
                  x={EDITOR_SAFE_MARGIN_PX * scale}
                  y={brandBandY * scale}
                  width={(scene.page.widthPx - EDITOR_SAFE_MARGIN_PX * 2) *
                    scale}
                  height={BACK_COVER_BRAND_BAND_PX * scale}
                  fill="#f5f5f4"
                  listening={false}
                />
                <Rect
                  x={EDITOR_SAFE_MARGIN_PX * scale}
                  y={brandBandY * scale}
                  width={(scene.page.widthPx - EDITOR_SAFE_MARGIN_PX * 2) *
                    scale}
                  height={1}
                  fill="#d6d3d1"
                  listening={false}
                />
                <Text
                  x={EDITOR_SAFE_MARGIN_PX * scale}
                  y={(brandBandY + BACK_COVER_BRAND_BAND_PX / 2) * scale -
                    9 * scale}
                  width={(scene.page.widthPx - EDITOR_SAFE_MARGIN_PX * 2) *
                    scale}
                  height={BACK_COVER_BRAND_BAND_PX * scale}
                  text={BACK_COVER_BRAND_TEXT}
                  fontFamily="Helvetica, Arial, sans-serif"
                  fontSize={18 * scale}
                  fontStyle="bold"
                  fill="#44403c"
                  align="center"
                  verticalAlign="top"
                  listening={false}
                />
              </>
            )
            : null}
        </Layer>
      </Stage>
    </div>
  );
}
