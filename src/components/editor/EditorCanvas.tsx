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
import GuidedCanvasText from "./GuidedCanvasText";
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
  /** Upper bound for the stage width; the stage also fits its container. */
  maxWidth?: number;
  /** Upper bound for the stage height so the whole page stays in view. */
  maxHeight?: number;
  /** Horizontal background swipe gestures (element drags are unaffected). */
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  /** Commit an inline (double-click) text edit; the caller routes template
   * text to overrides and user text to the scene. */
  onTextCommit?: (elementId: string, text: string) => void;
  onTextDraft?: (elementId: string, text: string | null) => void;
}

const CANVAS_MAX_WIDTH_PX = 420;
const SWIPE_MIN_DISTANCE_PX = 60;
const SWIPE_MAX_DRIFT_PX = 40;
const SWIPE_MAX_DURATION_MS = 600;

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
  isEditing = false,
  onSelect,
  onEnterEdit,
  onDragEnd,
  onTransformEnd,
}: {
  element: Extract<EditorElement, { type: "text" }>;
  scale: number;
  isSelected: boolean;
  isEditing?: boolean;
  onSelect: () => void;
  onEnterEdit?: () => void;
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
    if (
      !isSelected || isEditing || !nodeRef.current || !transformerRef.current
    ) {
      return;
    }

    transformerRef.current.nodes([nodeRef.current]);
    transformerRef.current.getLayer()?.batchDraw();
    // isEditing must re-run the attach: the Transformer unmounts for the
    // inline textarea session, so ending the edit remounts it empty and the
    // controls only return once the nodes are attached again.
  }, [isSelected, isEditing]);

  if (element.typographyVersion) {
    return (
      <GuidedCanvasText
        element={element}
        scale={scale}
        isSelected={isSelected}
        onSelect={onSelect}
        onDragEnd={onDragEnd}
        onTransformEnd={onTransformEnd}
      />
    );
  }

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
        draggable={!element.locked && !isEditing}
        visible={element.visible && !isEditing}
        onClick={onSelect}
        onTap={onSelect}
        onDblClick={onEnterEdit}
        onDblTap={onEnterEdit}
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
      {isSelected && !isEditing
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
  isEditing = false,
  onSelect,
  onEnterEdit,
}: {
  element: EditorElement;
  scale: number;
  assetMap: Map<string, CanvasAsset>;
  isTextEditable?: boolean;
  isSelected?: boolean;
  isEditing?: boolean;
  onSelect?: () => void;
  onEnterEdit?: () => void;
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
    if (element.typographyVersion) {
      return (
        <GuidedCanvasText
          element={element}
          scale={scale}
          isSelected={isSelected}
          onSelect={editable ? onSelect : undefined}
        />
      );
    }
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
          visible={element.visible && !isEditing}
          listening={true}
          onMouseEnter={(e) =>
            setCursorStyle(e, editable ? "text" : "not-allowed")}
          onMouseLeave={(e) => setCursorStyle(e, "default")}
          onClick={editable ? onSelect : () => {/* blocked */}}
          onTap={editable ? onSelect : undefined}
          onDblClick={editable ? (onEnterEdit ?? onSelect) : undefined}
          onDblTap={editable ? (onEnterEdit ?? onSelect) : undefined}
        />
        {editable && isSelected && !isEditing
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

/**
 * Inline text editor: a textarea overlaid on the hidden Konva Text node,
 * matched to its position, font and scale so typing happens "inside" the
 * text box. Enter inserts a newline; Ctrl/Cmd+Enter or blur commits the
 * edit as a single history step; Escape cancels. Guided-typography text
 * (path-rendered) is not editable inline and keeps the properties panel.
 */
function CanvasTextEditor({
  element,
  scale,
  onCommit,
  onCancel,
  onDraft,
}: {
  element: Extract<EditorElement, { type: "text" }>;
  scale: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
  onDraft?: (text: string) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Guard against a blur commit firing after an explicit commit/cancel.
  const doneRef = useRef(false);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.select();
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, []);

  function commit(node: HTMLTextAreaElement) {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(node.value);
  }

  return (
    <textarea
      ref={textareaRef}
      aria-label="Edit text on page"
      defaultValue={element.text}
      maxLength={5000}
      onBlur={(event) => commit(event.currentTarget)}
      onInput={(event) => {
        const node = event.currentTarget;
        onDraft?.(node.value);
        node.style.height = "auto";
        node.style.height = `${node.scrollHeight}px`;
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (!doneRef.current) {
            doneRef.current = true;
            onCancel();
          }
        } else if (
          event.key === "Enter" && (event.ctrlKey || event.metaKey)
        ) {
          event.preventDefault();
          commit(event.currentTarget);
        }
      }}
      style={{
        position: "absolute",
        left: element.x * scale,
        top: element.y * scale,
        width: element.width * scale,
        minHeight: element.height * scale,
        transform: `rotate(${element.rotation}deg)`,
        transformOrigin: "top left",
        margin: 0,
        padding: 0,
        border: "none",
        outline: "1px dashed #3b82f6",
        background: "transparent",
        resize: "none",
        overflow: "hidden",
        fontFamily: element.fontFamily,
        fontSize: element.fontSize * scale,
        fontWeight: element.fontWeight,
        lineHeight: element.lineHeight,
        letterSpacing: element.letterSpacing * scale,
        color: element.color,
        textAlign: element.align,
        zIndex: 10,
      }}
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
  maxWidth,
  maxHeight,
  onSwipeLeft,
  onSwipeRight,
  onTextCommit,
  onTextDraft,
}: EditorCanvasProps) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [containerHeight, setContainerHeight] = useState<number | null>(null);
  // Fit the stage to the workspace column when a maxWidth is supplied;
  // without one, keep the legacy fixed 420px presentation.
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width && width > 0) setContainerWidth(width);
      const height = entries[0]?.contentRect.height;
      if (height && height > 0) setContainerHeight(height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const widthCap = maxWidth ?? CANVAS_MAX_WIDTH_PX;
  const availableWidth = maxWidth != null && containerWidth != null
    ? Math.min(containerWidth, maxWidth)
    : widthCap;
  // With maxWidth but no maxHeight (the xl app frame) the container height
  // is flex-determined, so fitting it keeps the page inside the viewport.
  const heightCap = maxHeight ??
    (maxWidth != null
      ? containerHeight ?? Number.POSITIVE_INFINITY
      : Number.POSITIVE_INFINITY);
  const scale = Math.min(
    1,
    availableWidth / scene.page.widthPx,
    heightCap / scene.page.heightPx,
  );
  const stageWidth = scene.page.widthPx * scale;
  const stageHeight = scene.page.heightPx * scale;
  const isBackCover = pageLabel === "BACK_COVER";
  const brandBandPx = isBackCover ? BACK_COVER_BRAND_BAND_PX : 0;
  const safeAreaY = EDITOR_SAFE_MARGIN_PX;
  const safeAreaHeight = scene.page.heightPx - EDITOR_SAFE_MARGIN_PX * 2;
  const brandBandY = safeAreaY + safeAreaHeight - brandBandPx;
  const [cropModeId, setCropModeId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const swipeRef = useRef<
    {
      x: number;
      y: number;
      time: number;
      active: boolean;
    } | null
  >(null);
  const swipeEnabled = Boolean(onSwipeLeft || onSwipeRight);
  const assetMap = new Map(
    assets.map((asset) => [asset.id, asset]),
  );

  // A page swipe only counts when the gesture starts on the stage
  // background, so dragging, resizing or cropping an element never
  // navigates away from the page.
  function handleTouchStart(event: Konva.KonvaEventObject<TouchEvent>) {
    if (!swipeEnabled || event.target !== event.target.getStage()) return;
    const touch = event.evt.touches[0];
    if (!touch || event.evt.touches.length > 1) return;
    swipeRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      time: Date.now(),
      active: true,
    };
  }

  function handleTouchMove(event: Konva.KonvaEventObject<TouchEvent>) {
    const swipe = swipeRef.current;
    if (!swipe?.active) return;
    const touch = event.evt.touches[0];
    if (!touch) return;
    if (Math.abs(touch.clientY - swipe.y) > SWIPE_MAX_DRIFT_PX) {
      swipe.active = false;
    }
  }

  function handleTouchEnd(event: Konva.KonvaEventObject<TouchEvent>) {
    const swipe = swipeRef.current;
    swipeRef.current = null;
    if (!swipe?.active) return;
    const touch = event.evt.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - swipe.x;
    const dy = touch.clientY - swipe.y;
    const elapsed = Date.now() - swipe.time;
    if (
      elapsed > SWIPE_MAX_DURATION_MS ||
      Math.abs(dx) < SWIPE_MIN_DISTANCE_PX ||
      Math.abs(dy) > SWIPE_MAX_DRIFT_PX
    ) return;
    if (dx < 0) onSwipeLeft?.();
    else onSwipeRight?.();
  }

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
  // has moved to a different element. Adjusted during render (React's
  // "state adjustment" pattern) rather than in a syncing effect, so the crop
  // mode cannot render another frame against a stale element.
  if (cropModeId) {
    const stillExists = scene.elements.some((element) =>
      element.id === cropModeId && element.type === "image"
    );
    if (
      !stillExists ||
      (selectedElementId && selectedElementId !== cropModeId)
    ) {
      setCropModeId(null);
    }
  }

  // Leave inline editing if the target text element no longer exists (page
  // switch, deletion). Blur commits normally fire first; this is the guard
  // for changes that arrive without a blur.
  if (
    editingTextId &&
    !scene.elements.some((element) =>
      element.id === editingTextId && element.type === "text"
    )
  ) {
    setEditingTextId(null);
  }

  const editingElement = editingTextId
    ? scene.elements.find((element): element is Extract<
      EditorElement,
      { type: "text" }
    > => element.id === editingTextId && element.type === "text")
    : undefined;

  function finishTextEdit(text: string | null) {
    const element = editingElement;
    setEditingTextId(null);
    if (element) onTextDraft?.(element.id, null);
    if (!element || text === null || text === element.text) return;
    onTextCommit?.(element.id, text);
  }

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
    <div
      ref={containerRef}
      // h-full + flex centering only bite when an ancestor gives this box a
      // definite height (the xl app frame); the ResizeObserver then measures
      // the column, not the stage, so the page fits without feedback loops.
      className="card flex h-full flex-col justify-center p-4"
      style={{
        background: "var(--color-surface)",
        ...(swipeEnabled ? { touchAction: "pan-y" } : {}),
      }}
    >
      {
        /* Relative wrapper sized to the stage so the inline text editor can
          be positioned in stage coordinates; the white page surface and its
          shadow never stretch across the whole workspace column. */
      }
      <div
        style={{
          position: "relative",
          width: stageWidth,
          height: stageHeight,
          margin: "0 auto",
          boxShadow: "0 20px 50px rgba(0, 0, 0, 0.1)",
        }}
      >
        <Stage
          ref={stageRef}
          width={stageWidth}
          height={stageHeight}
          className="rounded-xl bg-white"
          style={{
            width: stageWidth,
            height: stageHeight,
          }}
          onMouseDown={(event) => {
            if (event.target === event.target.getStage()) {
              onSelectElement(null);
              setCropModeId(null);
            }
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={() => {
            swipeRef.current = null;
          }}
        >
          <Layer>
            <Rect
              x={0}
              y={0}
              width={stageWidth}
              height={stageHeight}
              fill={scene.page.backgroundColor}
              listening={false}
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
              .sort((left, right) => left.zIndex - right.zIndex)
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
                      isEditing={editingTextId === element.id}
                      onSelect={() => onSelectElement(element.id)}
                      onEnterEdit={isTextEditable &&
                          element.type === "text" &&
                          !element.typographyVersion &&
                          !element.locked && onTextCommit
                        ? () => {
                          onSelectElement(element.id);
                          setEditingTextId(element.id);
                        }
                        : undefined}
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
                      isEditing={editingTextId === element.id}
                      onSelect={() => onSelectElement(element.id)}
                      onEnterEdit={!element.locked && onTextCommit
                        ? () => setEditingTextId(element.id)
                        : undefined}
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
        {editingElement && onTextCommit
          ? (
            <CanvasTextEditor
              key={editingElement.id}
              element={editingElement}
              scale={scale}
              onCommit={(text) => finishTextEdit(text)}
              onCancel={() => finishTextEdit(null)}
              onDraft={(text) => onTextDraft?.(editingElement.id, text)}
            />
          )
          : null}
      </div>
    </div>
  );
}
