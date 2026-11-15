import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createEmptyEditorScene, editorSceneSchema, type EditorElement } from '@/lib/editor/schema';
import { styleOverrideSchema, DESIGN_FAMILIES } from '@/lib/editor/design-schema';
import { resolveDesignElement, resolveSceneDesign, designForPreset } from '@/lib/editor/design';
import { applyCanvasGeometry, applyDesignAction } from '@/lib/editor/design-actions';
import { faceId, FONT_MANIFEST, getDesignFont, requiredDesignFonts } from '@/lib/editor/design-fonts';
import { loadServerDesignFonts } from '@/lib/pdf/design-fonts-server';
import { layoutDesignText, designTextCapacity } from '@/lib/editor/design-text-layout';
import { contrastRatio, pointsPerScenePixel, preflightDesign } from '@/lib/editor/design-preflight';
import { SEED_RECIPES, elementSeeds, backgroundFor } from '../../prisma/seed-recipes';
import { preflightTemplateRows } from '@/lib/ai/template-preflight';
import { renderSnapshotV1Schema, renderSnapshotV2Schema } from '@/lib/pdf/snapshot';
import { DEFAULT_PRINT_PROFILE } from '@/lib/pdf/print-profile';
import { PAGE_LABELS } from '@/lib/constants';
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const text = (patch: Partial<Extract<EditorElement, { type: 'text' }>> = {}): Extract<EditorElement, { type: 'text' }> => ({
  id: 'body', type: 'text', x: 60, y: 110, width: 580, height: 620, rotation: 0, opacity: 1, locked: false, visible: true, zIndex: 0,
  text: 'The lantern shone beside the sea.', fontFamily: 'Lora', fontSize: 33, fontWeight: 400, lineHeight: 1.45,
  letterSpacing: 0, color: '#3f2d1d', align: 'left', verticalAlign: 'top', typographyVersion: 1, designRole: 'body', ...patch,
});
const scene = (element = text()) => ({ ...createEmptyEditorScene(), elements: [element] });
beforeAll(() => loadServerDesignFonts(DESIGN_FAMILIES.flatMap(fontFamily => [400, 700].flatMap(fontWeight => [false, true].map(italic => text({ fontFamily, fontWeight, italic }))))));

describe('formatting isolation and resolution', () => {
  it.each(['x', 'width', 'text', 'locked', 'designRole', 'stylePolicy', 'id'])('rejects structural override %s', key => {
    expect(styleOverrideSchema.safeParse({ [key]: 10 }).success).toBe(false);
  });
  it('retains untouched legacy JSON and untagged size/weight', () => {
    const legacy = text({ typographyVersion: undefined, designRole: undefined, fontFamily: 'Arial', fontSize: 52, fontWeight: 700 });
    expect(resolveDesignElement(legacy)).toEqual(legacy);
    const result = resolveDesignElement(legacy, designForPreset('playful'));
    expect(result).toMatchObject({ fontFamily: 'Nunito', fontSize: 52, fontWeight: 700, typographyVersion: 1 });
    expect(editorSceneSchema.parse(createEmptyEditorScene())).not.toHaveProperty('design');
  });
  it('applies preset, role, local precedence and reset without changing words', () => {
    const source = { ...scene(), design: { ...designForPreset('modern'), roleStyles: { body: { fontSize: 35 } } }, elementStyleOverrides: { body: { fontSize: 37 } } };
    expect(resolveSceneDesign(source).elements[0]).toMatchObject({ fontFamily: 'Source Sans 3', fontSize: 37 });
    const reset = applyDesignAction(source, [], { type: 'reset', elementId: 'body' }).scene;
    expect(resolveSceneDesign(reset).elements[0]).toMatchObject({ fontSize: 35, text: source.elements[0].text });
    expect(applyDesignAction(source, [], { type: 'reset' }).scene).toEqual(scene());
  });
  it('rejects protected, unknown and cross-page IDs and intersects permissions', () => {
    expect(() => resolveSceneDesign({ ...scene(), templateStyleOverrides: { other: { color: '#000000' } } }, [text({ id: 'template' })])).toThrow('Unknown');
    expect(() => resolveDesignElement(text({ locked: true }), undefined, { italic: true })).toThrow('protected');
    expect(resolveDesignElement(text({ designRole: 'brand' }), designForPreset('playful'))).toEqual(text({ designRole: 'brand' }));
    expect(resolveDesignElement(text({ stylePolicy: { allowed: ['fontSize'], minFontSize: 40, maxFontSize: 45 } }), designForPreset('modern'))).toMatchObject({ fontSize: 40, fontFamily: 'Lora' });
    expect(() => resolveDesignElement(text({ stylePolicy: { allowed: ['fontSize'], minFontSize: 40 } }), undefined, { fontSize: 30 })).toThrow('limits');
  });
  it('preserves source styling through transforms and rejects collisions', () => {
    const source = { ...scene(), design: designForPreset('modern') };
    const rendered = resolveSceneDesign(source);
    rendered.elements[0].x = 90;
    expect(applyCanvasGeometry(source, rendered).elements[0]).toEqual({ ...source.elements[0], x: 90 });
    expect(() => resolveSceneDesign(source, [text()])).toThrow('Duplicate');
  });
  it('keeps layers, geometry and local overrides during bulk actions', () => {
    const source = { ...scene(), elementStyleOverrides: { body: { italic: true } } };
    const template = text({ id: 'template' });
    const next = applyDesignAction(source, [template], { type: 'preset', presetId: 'playful' }).scene;
    expect(next.elements).toEqual(source.elements);
    expect(next.elementStyleOverrides).toEqual(source.elementStyleOverrides);
    expect(resolveSceneDesign(next, [template]).elements.map(el => el.id)).toEqual(['template', 'body']);
  });
  it('repeats bulk edits without treating them as local overrides or applying a preset', () => {
    const source = scene(text({ designRole: undefined, fontSize: 48 }));
    const first = applyDesignAction(source, [], { type: 'style', patch: { tracking: 0.02 } }).scene;
    const second = applyDesignAction(first, [], { type: 'style', patch: { tracking: 0.06 } }).scene;
    expect(editorSceneSchema.safeParse(second).success).toBe(true);
    expect(resolveSceneDesign(second).elements[0]).toMatchObject({ tracking: 0.06, fontSize: 48 });
    expect(second.design?.presetId).toBeUndefined();
    expect(second.elementStyleOverrides).toBeUndefined();
    const local = applyDesignAction(second, [], { type: 'style', elementId: 'body', patch: { tracking: 0.01 } }).scene;
    expect(resolveSceneDesign(applyDesignAction(local, [], { type: 'style', patch: { tracking: 0.1 } }).scene).elements[0]).toMatchObject({ tracking: 0.01 });
  });
  it('intersects spacing policies for role changes and rejects forbidden local values', () => {
    const element = text({ stylePolicy: { allowed: ['lineHeight'], limits: { lineHeight: { min: 1.2, max: 1.3 } } } });
    expect(resolveDesignElement(element, designForPreset('classic'))).toMatchObject({ lineHeight: 1.3 });
    expect(() => resolveDesignElement(element, undefined, { lineHeight: 1.5 })).toThrow('limits');
  });
  it('resolves explicit backgrounds after pinned paper', () => {
    expect(resolveSceneDesign({ ...scene(), backgroundOverride: '#eeeeee' }, [], '#000000').page.backgroundColor).toBe('#eeeeee');
  });
});

describe('qualified typography v1', () => {
  it.each(DESIGN_FAMILIES)('verifies all four %s faces and their explicit Latin Extended-A coverage', fontFamily => {
    for (const fontWeight of [400, 700]) for (const italic of [false, true]) {
      const element = text({ fontFamily, fontWeight, italic, text: 'Àéñö Łódź č Œuvre — “hello”…' });
      expect(FONT_MANIFEST[faceId(element)]).toHaveLength(2);
      const fonts = getDesignFont(faceId(element));
      for (let code = 0x0100; code <= 0x017f; code++) {
        const character = String.fromCodePoint(code);
        const unsupported = fontFamily === 'Lora' ? [0x0138] : fontFamily === 'Nunito' ? [0x0133, 0x017f] : [];
        expect(fonts.some(font => font.charToGlyphIndex(character) !== 0), `${faceId(element)} U+${code.toString(16)}`).toBe(!unsupported.includes(code));
        if (unsupported.includes(code)) expect(() => layoutDesignText({ ...element, text: character })).toThrow('Choose Source Sans 3');
      }
      expect(layoutDesignText(element).path).toContain('M');
    }
  });
  it('is deterministic and uses real advances, kerning and tracking', () => {
    const element = text({ text: 'AVATAR' });
    expect(layoutDesignText(element)).toEqual(layoutDesignText(element));
    expect(layoutDesignText(text({ text: 'WWWW' })).maxLineWidth).toBeGreaterThan(layoutDesignText(text({ text: 'iiii' })).maxLineWidth);
    const pair = layoutDesignText(text({ text: 'AV' })).glyphs;
    expect(pair).toHaveLength(2);
    expect(pair[1].x - pair[0].x).toBeLessThan(pair[0].advance);
    const regular = layoutDesignText(element);
    const spaced = layoutDesignText({ ...element, tracking: 0.1 });
    expect(spaced.maxLineWidth - regular.maxLineWidth).toBeCloseTo(5 * 3.3, 4);
    expect(regular.bounds.y1).toBeGreaterThanOrEqual(0);
    expect(regular.bounds.y2).toBeLessThanOrEqual(regular.height);
  });
  it('preserves blank paragraphs and deterministic long-token breaking', () => {
    const result = layoutDesignText(text({ text: 'One\n\nTwo', firstLineIndent: 1, paragraphGap: 0.5 }));
    expect(result.lines.map(line => line.text)).toEqual(['One', '', 'Two']);
    expect(result.lines.every(line => line.x === 33)).toBe(true);
    const broken = layoutDesignText(text({ text: 'supercalifragilisticexpialidocious', width: 80 }));
    expect(broken.lines.map(line => line.text).join('')).toBe('supercalifragilisticexpialidocious');
    expect(broken.maxLineWidth).toBeLessThanOrEqual(80);
  });
  it('serializes fractional and centered outlines without nonfinite SVG coordinates', () => {
    for (const fontFamily of DESIGN_FAMILIES) for (const fontSize of [33, 33.3, 64]) {
      const result = layoutDesignText(text({ fontFamily, fontSize, fontWeight: 700, text: 'The Lantern and the Sea', height: 240, verticalAlign: 'middle' }));
      expect(result.path).not.toMatch(/NaN|Infinity|undefined/);
      expect(result.path.match(/M/g)?.length).toBeGreaterThanOrEqual('TheLanternandtheSea'.length);
    }
  });
  it('rejects missing glyphs explicitly', () => expect(() => layoutDesignText(text({ text: 'Hello 🦄' }))).toThrow('does not contain'));
  it('recomputes capacity from font metrics and styles', () => {
    expect(designTextCapacity(text({ fontSize: 50 }))).toBeLessThan(designTextCapacity(text()));
    expect(designTextCapacity(text({ tracking: 0.12 }))).toBeLessThan(designTextCapacity(text()));
    expect(designTextCapacity(text({ paragraphGap: 1.5, firstLineIndent: 2 }))).toBeLessThan(designTextCapacity(text()));
  });
});

describe('print safety and snapshots', () => {
  it('uses smaller folded scale, checks overflow and keeps contrast advisory', () => {
    const source = scene();
    expect(pointsPerScenePixel(source, 'PAGE_2')).toBeLessThan(pointsPerScenePixel(source, 'PAGE_2', true));
    expect(preflightDesign(scene(text({ fontSize: 28 })), 'PAGE_2').some(issue => issue.message.includes('8 pt'))).toBe(true);
    expect(preflightDesign(scene(text({ height: 20 })), 'PAGE_2').some(issue => issue.message.includes('overflows'))).toBe(true);
    expect(preflightDesign(scene(text({ color: '#ffffff' })), 'PAGE_2').some(issue => issue.severity === 'warning')).toBe(true);
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21);
  });
  it('ships a separate managed starter with eight usable generated slots', () => {
    const recipe = SEED_RECIPES.find(recipe => recipe.key === 'seed-story-guided-v1')!;
    const { result, manifest } = preflightTemplateRows({ templateId: 'test', templateVersion: 1, rows: elementSeeds(recipe), pageBackgrounds: new Map(PAGE_LABELS.map(label => [label, backgroundFor(recipe, label)])) });
    expect(result.issues).toEqual([]);
    expect(manifest.pages.flatMap(page => page.slots.filter(slot => slot.generated))).toHaveLength(8);
    expect(SEED_RECIPES.filter(recipe => recipe.key === 'seed-story-v1')).toHaveLength(1);
  });
  it('freezes fonts/engine, rejects tampering and retains legacy parsing', () => {
    const pages = PAGE_LABELS.map(pageLabel => ({ pageLabel, scene: scene() }));
    const ids = requiredDesignFonts(pages.flatMap(page => page.scene.elements));
    const input = { version: 2, userId: 'test', submissionId: 'test', submissionRevision: 1, templateId: null, templateVersion: null, title: 'Test', renderer: 'raster', mode: 'EDITOR', pages, assets: [], images: [], printProfile: DEFAULT_PRINT_PROFILE.id, outputs: ['print-sheet', 'reading-pdf'], typography: { version: 1, fonts: Object.fromEntries(ids.map(id => [id, FONT_MANIFEST[id].map(asset => asset.sha256)])) } };
    expect(renderSnapshotV2Schema.safeParse(input).success).toBe(true);
    expect(renderSnapshotV2Schema.safeParse({ ...input, typography: undefined }).success).toBe(false);
    expect(renderSnapshotV2Schema.safeParse({ ...input, typography: { ...input.typography, version: 2 } }).success).toBe(false);
    const legacy = { version: 1, userId: 'test', submissionId: 'test', renderer: 'raster', mode: 'EDITOR', pages: pages.map(page => ({ ...page, scene: createEmptyEditorScene() })), assets: [], images: [] };
    expect(renderSnapshotV1Schema.safeParse(legacy).success).toBe(true);
    expect(renderSnapshotV1Schema.safeParse({ ...legacy, pages }).success).toBe(false);
  });
});
