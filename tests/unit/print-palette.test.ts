import { describe, expect, it } from 'vitest';
import { SEED_RECIPES, elementSeeds, backgroundFor } from '../../prisma/seed-recipes';
import { PAGE_LABELS } from '@/lib/constants';
import { buildManifestFromRows, buildPinnedTemplate, parsePinnedTemplate } from '@/lib/ai/template-contract';
import { editorElementSchema, type EditorElement } from '@/lib/editor/schema';
import { applyPrintPalette, isPrintSafeColor, printSafetyIssues, PRINT_PALETTES, selectPrintPalette } from '@/lib/ai/print-palette';
import { loadServerDesignFonts } from '@/lib/pdf/design-fonts-server';

function recipePin(index: number) {
  const recipe = SEED_RECIPES[index];
  const rows = elementSeeds(recipe);
  loadServerDesignFonts(rows.map((row) => editorElementSchema.parse(JSON.parse(row.elementJson))));
  const { manifest } = buildManifestFromRows({ templateId: 'palette-test', templateVersion: 1, rows, pageBackgrounds: new Map(PAGE_LABELS.map((label) => [label, backgroundFor(recipe, label)])) });
  return buildPinnedTemplate({ templateId: manifest.templateId, templateVersion: 1, manifest, pages: manifest.pages.map((page) => ({
    pageLabel: page.pageLabel,
    backgroundColor: page.backgroundColor,
    elements: rows.filter((row) => row.pageLabel === page.pageLabel).map((row) => editorElementSchema.parse(JSON.parse(row.elementJson))),
  })) });
}

function withoutColors(element: EditorElement) {
  const copy = { ...element } as Record<string, unknown>;
  delete copy.color; delete copy.fill; delete copy.stroke;
  return copy;
}

describe('AI home-printer palettes', () => {
  it.each(PRINT_PALETTES)('$id qualifies light large areas and soft accents', (palette) => {
    expect(isPrintSafeColor(palette.cover)).toBe(true);
    expect(isPrintSafeColor(palette.paper)).toBe(true);
    expect(isPrintSafeColor(palette.accent, false)).toBe(true);
  });

  it.each(['#0f172a', '#7c2d12', '#ea580c', '#ff0000', '#000', 'invalid'])('rejects deep/saturated large fills: %s', (color) => {
    expect(isPrintSafeColor(color)).toBe(false);
  });

  it('accepts shorthand white and rejects malformed colors', () => {
    expect(isPrintSafeColor('#fff')).toBe(true);
    expect(isPrintSafeColor('#zzzzzz', false)).toBe(false);
  });

  it.each(SEED_RECIPES.map((recipe, index) => ({ name: recipe.title, index })))('qualifies every palette on $name without geometry or artwork changes', { timeout: 20000 }, ({ index }) => {
    const original = recipePin(index);
    const before = JSON.stringify(original);
    for (const palette of PRINT_PALETTES) {
      const safe = applyPrintPalette(original, palette);
      expect(printSafetyIssues(safe)).toEqual([]);
      expect(parsePinnedTemplate(safe)).not.toBeNull();
      expect(JSON.stringify(original)).toBe(before);
      for (const [pageIndex, page] of safe.pages.entries()) {
        expect(page.elements.map(withoutColors)).toEqual(original.pages[pageIndex].elements.map(withoutColors));
        expect(safe.manifest.pages[pageIndex].backgroundColor).toBe(page.backgroundColor);
        expect(safe.manifest.pages[pageIndex].slots).toEqual(original.manifest.pages[pageIndex].slots);
      }
      expect(applyPrintPalette(safe, palette)).toEqual(safe);
    }
  });

  it('replaces the guide navy cover and brand text while preserving white interiors', () => {
    const pin = recipePin(1);
    expect(pin.pages.find((page) => page.pageLabel === 'FRONT_COVER')?.backgroundColor).toBe('#0f172a');
    expect(selectPrintPalette(undefined, pin).id).toBe('mist');
    expect(selectPrintPalette('navy', pin).id).toBe('mist');
    expect(selectPrintPalette('sage', pin).id).toBe('sage');
    const safe = applyPrintPalette(pin, PRINT_PALETTES[0]);
    expect(safe.pages.find((page) => page.pageLabel === 'FRONT_COVER')?.backgroundColor).toBe('#edf2f7');
    expect(safe.pages.find((page) => page.pageLabel === 'PAGE_2')?.backgroundColor).toBe('#ffffff');
    const brand = safe.pages.find((page) => page.pageLabel === 'BACK_COVER')?.elements.find((el) => el.id === 'brand-strip');
    expect(brand?.type === 'text' && brand.color).toBe(PRINT_PALETTES[0].accentInk);
  });

  it('guards heavy backgrounds, fills, strokes, and low-contrast text', () => {
    const pin = recipePin(1);
    expect(printSafetyIssues(pin)).toEqual(expect.arrayContaining([expect.stringContaining('background is not print-safe'), expect.stringContaining('stroke is not print-safe')]));
    const safe = applyPrintPalette(pin, PRINT_PALETTES[0]);
    const cover = safe.pages.find((page) => page.pageLabel === 'FRONT_COVER')!;
    const title = cover.elements.find((el) => el.type === 'text')!;
    if (title.type === 'text') title.color = cover.backgroundColor;
    expect(printSafetyIssues(safe)).toContain(`FRONT_COVER ${title.id}: text contrast is below 4.5:1`);
  });

  it('lightens large panels and keeps text readable on small accent panels', () => {
    const pin = recipePin(1);
    const cover = pin.pages.find((page) => page.pageLabel === 'FRONT_COVER')!;
    const base = { x: 60, y: 140, width: 580, height: 150, rotation: 0, opacity: 1, locked: true, visible: true, zIndex: 0 };
    cover.elements.unshift({ ...base, id: 'large-panel', type: 'shape', shape: 'rect', fill: '#000000' });
    cover.elements.unshift({ ...base, width: 200, height: 40, id: 'small-panel', type: 'shape', shape: 'rect', fill: '#ff0000' });
    const safe = applyPrintPalette(pin, PRINT_PALETTES[0]);
    const elements = safe.pages.find((page) => page.pageLabel === 'FRONT_COVER')!.elements;
    const panel = elements.find((el) => el.id === 'large-panel')!;
    expect(panel.type === 'shape' && panel.fill).toBe(PRINT_PALETTES[0].cover);
    expect(printSafetyIssues(safe)).toEqual([]);
  });
});
