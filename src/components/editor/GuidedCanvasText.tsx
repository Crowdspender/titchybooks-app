"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Group, Path, Rect, Text, Transformer } from "react-konva";
import type Konva from "konva";
import {
    type DesignText,
    faceId,
    loadBrowserDesignFont,
} from "@/lib/editor/design-fonts";
import { layoutDesignText } from "@/lib/editor/design-text-layout";

export default function GuidedCanvasText(
    { element, scale, isSelected = false, onSelect, onDragEnd, onTransformEnd }:
        {
            element: DesignText;
            scale: number;
            isSelected?: boolean;
            onSelect?: () => void;
            onDragEnd?: (position: { x: number; y: number }) => void;
            onTransformEnd?: (
                next: {
                    x: number;
                    y: number;
                    width: number;
                    height: number;
                    rotation: number;
                },
            ) => void;
        },
) {
    const node = useRef<Konva.Group>(null);
    const transformer = useRef<Konva.Transformer>(null);
    const [loaded, setLoaded] = useState("");
    const [failure, setFailure] = useState("");
    const face = useMemo(() => {
        try {
            return { id: faceId(element), error: "" };
        } catch (error) {
            return {
                id: "",
                error: error instanceof Error
                    ? error.message
                    : "Unqualified font",
            };
        }
    }, [element]);
    const id = face.id;
    useEffect(() => {
        if (!id) return;
        let cancelled = false;
        loadBrowserDesignFont(id).then(() => {
            if (!cancelled) {
                setLoaded(id);
                setFailure("");
            }
        }).catch((error) => {
            if (!cancelled) setFailure(error.message);
        });
        return () => {
            cancelled = true;
        };
    }, [id]);
    const result = useMemo(() => {
        if (face.error) return { path: "", error: face.error };
        if (loaded !== id) {
            return { path: "", error: failure || "Loading font…" };
        }
        try {
            return { path: layoutDesignText(element).path, error: "" };
        } catch (error) {
            return {
                path: "",
                error: error instanceof Error
                    ? error.message
                    : "Cannot lay out text",
            };
        }
    }, [element, id, loaded, failure, face.error]);
    useEffect(() => {
        if (
            isSelected && onTransformEnd && node.current && transformer.current
        ) transformer.current.nodes([node.current]);
    }, [isSelected, onTransformEnd]);
    return (
        <>
            <Group
                ref={node}
                x={element.x * scale}
                y={element.y * scale}
                width={element.width * scale}
                height={element.height * scale}
                rotation={element.rotation}
                opacity={element.opacity}
                visible={element.visible}
                draggable={!!onDragEnd && !element.locked}
                onClick={onSelect}
                onTap={onSelect}
                onDragEnd={(event) =>
                    onDragEnd?.({
                        x: event.target.x() / scale,
                        y: event.target.y() / scale,
                    })}
                onTransformEnd={() => {
                    const group = node.current;
                    if (!group || !onTransformEnd) return;
                    onTransformEnd({
                        x: group.x() / scale,
                        y: group.y() / scale,
                        width: element.width * group.scaleX(),
                        height: element.height * group.scaleY(),
                        rotation: group.rotation(),
                    });
                    group.scale({ x: 1, y: 1 });
                }}
            >
                <Rect
                    width={element.width * scale}
                    height={element.height * scale}
                    fill="rgba(0,0,0,0)"
                    stroke={result.error
                        ? "#b91c1c"
                        : isSelected
                        ? "#3b82f6"
                        : undefined}
                    strokeWidth={1}
                    dash={[5, 4]}
                />
                {result.error
                    ? (
                        <Text
                            text={result.error}
                            fill="#b91c1c"
                            width={element.width * scale}
                            fontSize={12}
                            listening={false}
                        />
                    )
                    : (
                        <Path
                            data={result.path}
                            scaleX={scale}
                            scaleY={scale}
                            fill={element.color}
                            listening={false}
                        />
                    )}
            </Group>
            {isSelected && onTransformEnd && !element.locked && (
                <Transformer
                    ref={transformer}
                    keepRatio={false}
                    boundBoxFunc={(oldBox, newBox) =>
                        newBox.width < 20 || newBox.height < 20
                            ? oldBox
                            : newBox}
                />
            )}
        </>
    );
}
