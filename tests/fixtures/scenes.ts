import { createEmptyEditorScene, type EditorElement } from '@/lib/editor/schema';

const base = { x: 30, y: 40, width: 250, height: 90, rotation: 0, opacity: 1, locked: false, visible: true, zIndex: 0 };
export function textElement(id = 'text', text = id): EditorElement {
  return { ...base, type: 'text', id, text, fontFamily: 'Arial', fontSize: 32, fontWeight: 400,
    lineHeight: 1.2, letterSpacing: 0, color: '#123456', align: 'left' };
}
export function imageElement(assetId: string): EditorElement {
  return { ...base, id: `image-${assetId}`, type: 'image', assetId, crop: { x: 0, y: 0, scaleX: 1, scaleY: 1 } };
}
export function sceneWithText(text: string) {
  return { ...createEmptyEditorScene(), elements: [textElement(text)] };
}
