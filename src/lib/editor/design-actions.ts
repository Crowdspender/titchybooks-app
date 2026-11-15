import type { EditorElement, EditorScene } from './schema';
import { allowedStyleProperties, designForPreset, resolveSceneDesign, validateStyleOverride } from './design';
import type { DesignPalette, DesignRole, PresetId, StyleOverride } from './design-schema';

export type DesignAction =
  | { type: 'preset'; presetId: PresetId }
  | { type: 'palette'; palette: DesignPalette }
  | { type: 'style'; patch: StyleOverride; elementId?: string; role?: DesignRole }
  | { type: 'reset'; elementId?: string };

/** Presentation-only transaction. Call once for each affected page, then commit together. */
export function applyDesignAction(scene: EditorScene, templates: EditorElement[], action: DesignAction) {
  let next: EditorScene = { ...scene };
  let skipped = 0;
  if (action.type === 'preset') { next.design = designForPreset(action.presetId); delete next.backgroundOverride; }
  if (action.type === 'palette') { next.design = { ...(scene.design ?? { version: 1 }), palette: action.palette }; delete next.backgroundOverride; delete next.design.backgroundColor; }
  if (action.type === 'style' && !action.elementId) {
    const role = action.role ?? 'untagged';
    next.design = { ...(scene.design ?? { version: 1 }), roleStyles: { ...scene.design?.roleStyles, [role]: { ...scene.design?.roleStyles?.[role], ...action.patch } } };
  }
  if (action.type === 'reset' && !action.elementId) {
    const { design, templateStyleOverrides, elementStyleOverrides, backgroundOverride, ...rest } = next;
    void design; void templateStyleOverrides; void elementStyleOverrides; void backgroundOverride;
    next = rest;
  }
  const layers = [
    { elements: templates, key: 'templateStyleOverrides' as const },
    { elements: scene.elements, key: 'elementStyleOverrides' as const },
  ];
  for (const { elements, key } of layers) {
    const overrides = { ...scene[key] };
    for (const element of elements) {
      if (element.type !== 'text') continue;
      if ((action.type === 'style' || action.type === 'reset') && action.elementId && element.id !== action.elementId) continue;
      if (action.type === 'style' && !action.elementId && element.designRole !== action.role) continue;
      const allowed = allowedStyleProperties(element);
      if (!allowed.length) { skipped++; continue; }
      if (action.type === 'style') {
        if (!Object.keys(action.patch).some(key => allowed.some(property => property === key))) { skipped++; continue; }
        if (action.elementId) {
          const merged = { ...overrides[element.id], ...action.patch };
          validateStyleOverride(element, merged);
          overrides[element.id] = merged;
        }
      }
      if (action.type === 'reset' && action.elementId) delete overrides[element.id];
    }
    if (action.type === 'style' || (action.type === 'reset' && action.elementId)) {
      if (Object.keys(overrides).length) next[key] = overrides;
      else delete next[key];
    }
  }
  resolveSceneDesign(next, templates);
  return { scene: next, skipped };
}

/** Canvas geometry must not materialize computed preset styles into source elements. */
export function applyCanvasGeometry(source: EditorScene, rendered: EditorScene): EditorScene {
  const byId = new Map(rendered.elements.map(element => [element.id, element]));
  return { ...source, elements: source.elements.map(element => {
    const moved = byId.get(element.id);
    if (!moved) return element;
    return { ...element, x: moved.x, y: moved.y, width: moved.width, height: moved.height, rotation: moved.rotation };
  }) };
}
