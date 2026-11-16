import { describe, expect, it } from 'vitest';
import { PAGE_LABELS, type PageLabel } from '@/lib/constants';
import { measureTextBlock, type TextStyle } from '@/lib/pdf/text-layout';
import {
  interiorFlowPages,
  interiorFlowRepairTargets,
  interiorFlowSlotIds,
  interiorFlowWindow,
  paginatePlan,
  prepareAiBookLayout,
  type PaginationResult,
} from '@/lib/ai/flow';
import { buildManifestFromRows, buildPinnedTemplate, parsePinnedTemplate, type AiTemplateManifest, type AiTemplateSlot } from '@/lib/ai/template-contract';
import { editorElementSchema } from '@/lib/editor/schema';
import { loadServerDesignFonts } from '@/lib/pdf/design-fonts-server';
import { SEED_RECIPES, elementSeeds } from '../../prisma/seed-recipes';
import { NATURAL_GUIDE_SECTIONS } from '../fixtures/scenes';

// Deterministic legacy manifest: fontSize 20 / lineHeight 1.5 gives an exact
// 30px line step, so a 90px flow box holds exactly three wrapped lines and a
// 30px heading box exactly one heading line. At 200px width the tokens below
// pack three per line, so a nine-word paragraph is exactly one full page.
const LEGACY_STYLE: TextStyle = { fontFamily: 'Arial', fontSize: 20, fontWeight: 400, letterSpacing: 0, lineHeight: 1.5 };
const GUIDED_STYLE: TextStyle = { fontFamily: 'Lora', fontSize: 28, fontWeight: 400, letterSpacing: 0, lineHeight: 1.4, typographyVersion: 1 };
const INTERIOR: PageLabel[] = PAGE_LABELS.filter((label) => label !== 'FRONT_COVER' && label !== 'BACK_COVER');

interface ManifestOptions {
  headings?: boolean;
  guided?: boolean;
  flowHeight?: number;
  headingHeight?: number;
}

function makeSlot(id: string, pageLabel: PageLabel, box: { x: number; y: number; width: number; height: number }, style: TextStyle, fontFamily: string): AiTemplateSlot {
  return { id, pageLabel, role: 'body', generated: true, required: true, text: '', box, style, fontFamily, minChars: 40, maxChars: 2000 };
}

function makeManifest(options: ManifestOptions = {}): AiTemplateManifest {
  const style = options.guided ? GUIDED_STYLE : LEGACY_STYLE;
  const flowHeight = options.flowHeight ?? 90;
  const headingHeight = options.headingHeight ?? 30;
  return {
    schemaVersion: 1,
    templateId: 'flow-test',
    templateVersion: 1,
    capturedAt: '2024-01-01T00:00:00.000Z',
    pages: [
      { pageLabel: 'FRONT_COVER', backgroundColor: '#ffffff', slots: [], images: [] },
      { pageLabel: 'BACK_COVER', backgroundColor: '#ffffff', slots: [], images: [] },
      ...INTERIOR.map((pageLabel, index) => {
        const slots: AiTemplateSlot[] = [
          makeSlot(`story-page${index + 2}-body`, pageLabel, { x: 40, y: 100, width: 200, height: flowHeight }, style, style.fontFamily ?? 'Arial'),
        ];
        if (options.headings) {
          slots.unshift(
            makeSlot(`story-page${index + 2}-heading`, pageLabel, { x: 40, y: 60, width: 200, height: headingHeight }, style, style.fontFamily ?? 'Arial'),
          );
        }
        return { pageLabel, backgroundColor: '#ffffff', slots, images: [] };
      }),
    ],
  };
}

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];

/** `count` space-separated whole words drawn from a fixed vocabulary. */
function words(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, index) => WORDS[(offset + index) % WORDS.length]).join(' ');
}

/** Nine words starting at `offset`: exactly three wrapped lines = one full page. */
function fullPage(offset: number): string {
  return words(9, offset);
}

/** Body overrides for the interior flow slots, one entry per page. */
function bodies(manifest: AiTemplateManifest, texts: string[]): Array<{ templateElementId: string; text: string }> {
  return interiorFlowPages(manifest).map((page, index) => ({
    templateElementId: page.flow.id,
    text: texts[index] ?? '',
  }));
}

function headings(manifest: AiTemplateManifest, texts: string[]): Array<{ templateElementId: string; text: string }> {
  return interiorFlowPages(manifest).map((page, index) => ({
    templateElementId: page.heading!.id,
    text: texts[index] ?? '',
  }));
}

const HEADINGS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];

function styleOfSlot(slot: AiTemplateSlot): TextStyle {
  return { ...slot.style, fontFamily: slot.style.fontFamily ?? slot.fontFamily };
}

/** No page's flow text ever exceeds its box height. */
function expectNoOverflow(result: PaginationResult, manifest: AiTemplateManifest) {
  const pages = interiorFlowPages(manifest);
  result.pages.forEach((page, index) => {
    const slot = pages[index].flow;
    const height = measureTextBlock(page.flowText, slot.box.width, styleOfSlot(slot)).height;
    expect(height).toBeLessThanOrEqual(slot.box.height + 0.01);
  });
}

/** Recompute fullness independently, without charging an extra paragraph gap. */
function expectFilledToLastLine(result: PaginationResult, manifest: AiTemplateManifest) {
  const pages = interiorFlowPages(manifest);
  result.pages.forEach((page, index) => {
    const slot = pages[index].flow;
    const style = styleOfSlot(slot);
    const measured = page.flowText ? measureTextBlock(page.flowText, slot.box.width, style).height : 0;
    expect(page.usedHeight).toBeCloseTo(measured, 6);
    const noLineFits = page.flowText.trim().length > 0 && measured + style.fontSize * style.lineHeight > slot.box.height + 0.01;
    expect(page.filled).toBe(noLineFits);
    if ((manifest.fillAllInteriorPages || index < result.pages.length - 1) && !noLineFits) {
      expect(result.issues.some((issue) => issue.code === 'flow-underfull')).toBe(true);
    }
  });
}

function recipePin(index = 0) {
  const rows = elementSeeds(SEED_RECIPES[index]);
  const pages = PAGE_LABELS.map((pageLabel) => ({ pageLabel, elements: rows.filter((row) => row.pageLabel === pageLabel).map((row) => editorElementSchema.parse(JSON.parse(row.elementJson))) }));
  loadServerDesignFonts(pages.flatMap((page) => page.elements));
  const manifest = buildManifestFromRows({ templateId: 'layout-test', templateVersion: 1, rows }).manifest;
  return buildPinnedTemplate({ templateId: manifest.templateId, templateVersion: 1, manifest, pages });
}

describe('private new-AI full-page layout', () => {
  it.each([0, 1, 2, 3])('extends recipe %s toward a 60px bottom margin without modifying the source', (index) => {
    const pin = recipePin(index);
    const before = JSON.stringify(pin);
    const result = prepareAiBookLayout(pin);
    expect(JSON.stringify(pin)).toBe(before);
    expect(result.manifest.fillAllInteriorPages).toBe(true);
    expect(parsePinnedTemplate(JSON.parse(JSON.stringify(result)))?.manifest.fillAllInteriorPages).toBe(true);
    expect(parsePinnedTemplate(JSON.parse(before))?.manifest.fillAllInteriorPages).toBeUndefined();
    expect(prepareAiBookLayout(result)).toBe(result);
    for (const page of interiorFlowPages(result.manifest)) {
      const original = interiorFlowPages(pin.manifest).find((entry) => entry.pageLabel === page.pageLabel)!;
      expect(page.flow.box).toEqual({ ...original.flow.box, height: 940 - original.flow.box.y });
      expect(page.flow.style).toEqual(original.flow.style);
      expect(page.heading).toEqual(original.heading);
      const oldElement = pin.pages.find((entry) => entry.pageLabel === page.pageLabel)!.elements.find((element) => element.id === page.flow.id)!;
      const newElement = result.pages.find((entry) => entry.pageLabel === page.pageLabel)!.elements.find((element) => element.id === page.flow.id)!;
      expect(newElement).toEqual({ ...oldElement, height: page.flow.box.height });
    }
    expect(result.pages.filter((page) => !INTERIOR.includes(page.pageLabel))).toEqual(pin.pages.filter((page) => !INTERIOR.includes(page.pageLabel)));
    expect(interiorFlowWindow(result.manifest)!.min).toBeGreaterThan(interiorFlowWindow(pin.manifest)!.min);
  });

  it.each(['footer', 'artwork', 'rule', 'rotated artwork'] as const)('stops before a %s with clearance', (kind) => {
    const pin = recipePin();
    const page = pin.pages.find((entry) => entry.pageLabel === 'PAGE_2')!;
    const base = { id: 'obstacle', x: 60, y: 850, width: 200, height: 40, rotation: 0, opacity: 1, locked: true, visible: true, zIndex: 10 };
    const element = kind === 'footer'
      ? { ...page.elements[0], ...base }
      : kind === 'rule'
        ? { ...base, type: 'shape' as const, shape: 'line' as const, fill: 'transparent', stroke: '#000000', strokeWidth: 4 }
        : { ...base, type: 'image' as const, assetId: 'test-art', rotation: kind === 'rotated artwork' ? -90 : 0, crop: { x: 0, y: 0, scaleX: 1, scaleY: 1 } };
    page.elements.push(element);
    const result = prepareAiBookLayout(pin);
    const body = interiorFlowPages(result.manifest)[0].flow;
    const obstacleTop = kind === 'rotated artwork' ? 650 : kind === 'rule' ? 848 : 850;
    // An obstacle already overlapping the old frame prevents extension; never shrink.
    expect(body.box.height).toBe(Math.max(620, obstacleTop - 12 - body.box.y));
    expect(result.pages.find((entry) => entry.pageLabel === 'PAGE_2')!.elements.at(-1)).toEqual(element);
  });

  it('reserves the center-rotated raster artwork as well as its editor bounds', () => {
    const pin = recipePin();
    pin.pages.find((page) => page.pageLabel === 'PAGE_2')!.elements.push({
      id: 'rotated-art', type: 'image', assetId: 'test-art', x: 100, y: 850,
      width: 200, height: 40, rotation: 90, opacity: 1, locked: true, visible: true, zIndex: 5,
      crop: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
    });
    const body = interiorFlowPages(prepareAiBookLayout(pin).manifest)[0].flow;
    // The editor's top is 850, but raster center rotation places the top at 770.
    expect(body.box.y + body.box.height).toBe(770 - 12);
  });

  it('ignores invisible obstacles and full-page backgrounds behind the body', () => {
    const pin = recipePin();
    const page = pin.pages.find((entry) => entry.pageLabel === 'PAGE_2')!;
    page.elements[0].zIndex = 2;
    page.elements.push({ ...page.elements[0], id: 'hidden-footer', y: 750, height: 40, visible: false });
    page.elements.push({ id: 'background', type: 'shape', shape: 'rect', x: 0, y: 0, width: 700, height: 1000, rotation: 0, opacity: 1, locked: true, visible: true, zIndex: 0, fill: '#ffffff' });
    expect(interiorFlowPages(prepareAiBookLayout(pin).manifest)[0].flow.box.height).toBe(830);
  });

  it.each(['rotated', 'centered', 'already taller'] as const)('leaves a %s body frame intact', (kind) => {
    const pin = recipePin();
    const body = pin.pages.find((page) => page.pageLabel === 'PAGE_2')!.elements[0];
    if (body.type !== 'text') throw new Error('Expected text fixture');
    if (kind === 'rotated') body.rotation = 15;
    if (kind === 'centered') body.verticalAlign = 'middle';
    if (kind === 'already taller') {
      body.height = 850;
      interiorFlowPages(pin.manifest)[0].flow.box.height = 850;
    }
    const original = { ...body };
    const result = prepareAiBookLayout(pin);
    expect(result.pages.find((page) => page.pageLabel === 'PAGE_2')!.elements[0]).toEqual(original);
  });

  it('requires a full final page only for opted-in new layouts', () => {
    const legacy = makeManifest({ flowHeight: 180 });
    const manuscript = [...Array.from({ length: 5 }, (_, index) => words(18, index)), fullPage(0)];
    const overrides = bodies(legacy, manuscript);
    expect(paginatePlan({ manifest: legacy, overrides }).issues).toEqual([]);
    const manifest = { ...legacy, fillAllInteriorPages: true as const };
    const result = paginatePlan({ manifest, overrides });
    expect(result.pages.slice(0, -1).every((page) => page.filled)).toBe(true);
    expect(result.pages.at(-1)?.filled).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'flow-underfull', pageLabel: 'PAGE_7', message: expect.stringContaining('including the final page') })]);
    expect(result.issues[0].message).toContain('3 unused body lines');
    expect(interiorFlowWindow(manifest)!.min).toBeLessThan(interiorFlowWindow(manifest)!.max);
    expectFilledToLastLine(result, manifest);
    const repaired = paginatePlan({ manifest, overrides: bodies(manifest, Array.from({ length: 6 }, (_, index) => words(18, index))) });
    expect(repaired.issues).toEqual([]);
    expect(repaired.pages.every((page) => page.filled)).toBe(true);
    expectFilledToLastLine(repaired, manifest);
  });
});

describe('interiorFlowWindow', () => {
  it('publishes a reachable book-level window', () => {
    const window = interiorFlowWindow(makeManifest());
    expect(window).not.toBeNull();
    expect(window!.min).toBeGreaterThan(0);
    expect(window!.max).toBeGreaterThanOrEqual(window!.min);
  });

  it('reserves body capacity for inline section headings', () => {
    const plain = interiorFlowWindow(makeManifest())!;
    const headed = interiorFlowWindow(makeManifest({ headings: true }))!;
    expect(headed.min).toBeLessThan(plain.min);
    expect(headed.max).toBeLessThan(plain.max);
    expect(headed.min).toBeLessThanOrEqual(headed.max);
  });

  it('uses measured frame capacity even when role budgets are much smaller', () => {
    const manifest = makeManifest({ flowHeight: 300 });
    for (const page of interiorFlowPages(manifest)) page.flow.maxChars = 40;
    expect(interiorFlowWindow(manifest)!.min).toBeGreaterThan(6 * 40);
    expect(interiorFlowWindow(manifest)!.max).toBe(6 * 200);
  });

  it('loads guided fonts before calculating a restored manifest window', () => {
    const window = interiorFlowWindow(makeManifest({ guided: true, flowHeight: 300 }));
    expect(window!.min).toBeGreaterThan(0);
    expect(window!.max).toBeGreaterThanOrEqual(window!.min);
  });

  it('returns null when the template has no interior flow pages', () => {
    const manifest = makeManifest();
    manifest.pages = manifest.pages.filter((page) => page.pageLabel === 'FRONT_COVER' || page.pageLabel === 'BACK_COVER');
    expect(interiorFlowWindow(manifest)).toBeNull();
  });
});

describe('measured raw-section repairs', () => {
  it('does not subtract hypothetical inline headings from balanced new sections', () => {
    const pin = prepareAiBookLayout(recipePin(1));
    const pages = interiorFlowPages(pin.manifest);
    const overrides = bodies(pin.manifest, NATURAL_GUIDE_SECTIONS).concat(headings(pin.manifest, HEADINGS));
    const result = paginatePlan({ manifest: pin.manifest, overrides });
    expect(new Set(NATURAL_GUIDE_SECTIONS).size).toBe(6);
    expect(result.issues).toEqual([]);
    expect(result.pages.every((page) => page.filled && page.usedHeight === 714)).toBe(true);
    const plain = { ...pin.manifest, pages: pin.manifest.pages.map((page) => ({ ...page, slots: page.slots.filter((slot) => pages.some((flow) => flow.flow.id === slot.id)) })) };
    expect(interiorFlowWindow(pin.manifest)).toEqual(interiorFlowWindow(plain));
    const window = interiorFlowWindow(pin.manifest)!;
    const chars = NATURAL_GUIDE_SECTIONS.reduce((sum, text) => sum + text.length, 0);
    expect(chars).toBeGreaterThanOrEqual(window.min);
    expect(chars).toBeLessThanOrEqual(window.max);
    expectFilledToLastLine(result, pin.manifest);
  });

  it('targets short, long, and already-full ORIGINAL sections independently', () => {
    const manifest = prepareAiBookLayout(recipePin(1)).manifest;
    const texts = [...NATURAL_GUIDE_SECTIONS];
    texts[0] = `${texts[0]} A second bed needs the same careful observation of light and drainage. Test it before buying more seeds.`;
    texts[1] = texts[1].split('\n')[0];
    const overrides = bodies(manifest, texts).concat(headings(manifest, HEADINGS));
    const before = JSON.stringify({ manifest, overrides });
    const targets = interiorFlowRepairTargets({ manifest, overrides });
    expect(targets.map((target) => target.action)).toEqual(['condense', 'expand', 'keep', 'keep', 'keep', 'keep']);
    expect(targets[0].targetMaxChars).toBeLessThan(targets[0].currentChars);
    expect(targets[1].targetMinChars).toBeGreaterThan(targets[1].currentChars);
    for (const target of targets.slice(2)) {
      expect(target.targetMinChars).toBe(target.currentChars);
      expect(target.targetMaxChars).toBe(target.currentChars);
    }
    expect(JSON.stringify({ manifest, overrides })).toBe(before);
  });

  it.each([false, true])('measures condensation bounds with actual font and spacing (guided: %s)', (guided) => {
    const manifest = { ...makeManifest({ guided, flowHeight: 300 }), fillAllInteriorPages: true as const };
    if (guided) for (const page of interiorFlowPages(manifest)) Object.assign(page.flow.style, { paragraphGap: 12, firstLineIndent: 20 });
    const text = `${words(40)}\n${words(10, 2)}`;
    const overrides = bodies(manifest, Array(6).fill(text));
    const [target] = interiorFlowRepairTargets({ manifest, overrides });
    expect(target.action).toBe('condense');
    expect(target.targetMinChars).toBeGreaterThan(0);
    expect(target.targetMinChars).toBeLessThanOrEqual(target.targetMaxChars);
    expect(target.targetMaxChars).toBeLessThan(text.length);
    const slot = interiorFlowPages(manifest)[0].flow;
    const height = measureTextBlock(text.slice(0, target.targetMaxChars), slot.box.width, styleOfSlot(slot)).height;
    expect(height).toBeLessThanOrEqual(slot.box.height + 0.01);
    expect(height + target.lineStep).toBeGreaterThan(slot.box.height);
    expect(overrides[0].text).toBe(text);
  }, 10_000);

  it('does not infer acceptance from estimated character targets', () => {
    const manifest = prepareAiBookLayout(recipePin(1)).manifest;
    // Wide letters need substantially more lines than prose with the same count.
    const texts = Array(6).fill('Wide WMWM '.repeat(68).trim());
    const total = texts.reduce((sum: number, text: string) => sum + text.length, 0);
    const window = interiorFlowWindow(manifest)!;
    expect(total).toBeGreaterThanOrEqual(window.min);
    expect(total).toBeLessThanOrEqual(window.max);
    const overrides = bodies(manifest, texts).concat(headings(manifest, HEADINGS));
    expect(paginatePlan({ manifest, overrides }).issues.some((issue) => issue.code === 'flow-overflow')).toBe(true);
    expect(interiorFlowRepairTargets({ manifest, overrides }).every((target) => target.action === 'condense')).toBe(true);
  });

  it('provides finite expansion targets for empty sections without mutating them', () => {
    const manifest = { ...makeManifest(), fillAllInteriorPages: true as const };
    const overrides = bodies(manifest, []);
    const targets = interiorFlowRepairTargets({ manifest, overrides });
    expect(targets).toHaveLength(6);
    for (const target of targets) {
      expect(target.action).toBe('expand');
      expect(target.targetMinChars).toBeGreaterThan(0);
      expect(target.targetMaxChars).toBeGreaterThanOrEqual(target.targetMinChars);
      expect(Number.isFinite(target.targetMaxChars)).toBe(true);
    }
    expect(overrides.every((entry) => entry.text === '')).toBe(true);
  });

  it('does not apply the balanced-section repair policy to historical pins', () => {
    const manifest = makeManifest();
    expect(interiorFlowRepairTargets({ manifest, overrides: bodies(manifest, [words(100)]) })).toEqual([]);
  });
});

describe('interiorFlowSlotIds', () => {
  it('uses reading order even if persisted manifest pages are shuffled', () => {
    const manifest = makeManifest();
    manifest.pages.reverse();
    expect(interiorFlowPages(manifest).map((page) => page.pageLabel)).toEqual(INTERIOR);
  });

  it('separates flow bodies from the full interior set', () => {
    const ids = interiorFlowSlotIds(makeManifest({ headings: true }));
    expect(ids.flow).toEqual(INTERIOR.map((_, index) => `story-page${index + 2}-body`));
    expect(ids.interior).toEqual(expect.arrayContaining(ids.flow));
    expect(ids.interior).toHaveLength(12);
  });
});

describe('paginatePlan (legacy Arial measurement)', () => {
  it('fills every page to its last possible line before overflowing', () => {
    const manifest = makeManifest();
    // Eighteen lines of manuscript across six 3-line pages: each page fills
    // exactly and nothing is left over.
    const result = paginatePlan({
      manifest,
      overrides: bodies(manifest, [fullPage(0), fullPage(1), fullPage(2), fullPage(3), fullPage(4), fullPage(5)]),
    });
    expect(result.issues).toEqual([]);
    expect(result.pages.every((page) => page.filled)).toBe(true);
    expectNoOverflow(result, manifest);
    expectFilledToLastLine(result, manifest);
    // Each page holds exactly three wrapped lines.
    for (const page of result.pages) {
      expect(measureTextBlock(page.flowText, 200, LEGACY_STYLE).lineCount).toBe(3);
    }
  });

  it('splits only at wrapped-line boundaries, so words stay whole and in order', () => {
    const manifest = makeManifest();
    const source = [fullPage(0), fullPage(1), fullPage(2), fullPage(3), fullPage(4), fullPage(5)].join(' ');
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [source]) });
    const sourceWords = source.split(/\s+/).filter(Boolean);
    const placedWords = result.pages.map((page) => page.flowText).join(' ').split(/\s+/).filter(Boolean);
    // Every placed token is a whole vocabulary word (never a broken fragment).
    for (const token of placedWords) expect(WORDS).toContain(token);
    // Content is placed in reading order with no gaps, reordering, or loss up
    // to the capacity of the book; anything beyond is reported, not dropped.
    expect(placedWords).toEqual(sourceWords.slice(0, placedWords.length));
    expectNoOverflow(result, manifest);
    expectFilledToLastLine(result, manifest);
  });

  it('preserves paragraph breaks and blank lines across a split', () => {
    const manifest = makeManifest();
    // One section holding two paragraphs separated by a blank line, long enough
    // to split across pages.
    const body = `${words(20)}\n\n${words(20, 4)}`;
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [body]) });
    const combined = result.pages.map((page) => page.flowText).join('\n');
    // The blank line survives as an empty line somewhere in the repacked text.
    expect(result.pages.some((page) => page.flowText.split('\n').includes(''))).toBe(true);
    // Both paragraphs are present and still separated by a blank line.
    expect(combined.split('\n').filter((line) => line === '').length).toBeGreaterThan(0);
    expectNoOverflow(result, manifest);
  });

  it('starts a new section at the top of a page when its heading no longer fits', () => {
    const manifest = makeManifest({ headings: true });
    // Section 1 is exactly one page; section 2 is long, so it cannot squeeze
    // its heading onto the full page 2 and must start at the top of page 3.
    const overrides = bodies(manifest, [fullPage(0), words(40), '', '', '', '']).concat(headings(manifest, HEADINGS));
    const result = paginatePlan({ manifest, overrides });
    expect(result.pages[0].flowText).toBe(fullPage(0));
    expect(result.pages[0].headingText).toBe('One');
    expect(result.pages[1].headingText).toBe('Two');
    expect(result.pages[1].headingText).not.toContain('continued');
    expectNoOverflow(result, manifest);
  });

  it('gives continuation pages a "(continued)" running head', () => {
    const manifest = makeManifest({ headings: true });
    // A single long section that runs across several pages: continuation pages
    // carry "<heading> (continued)" so no generated slot is left empty.
    const overrides = bodies(manifest, [words(60), '', '', '', '', '']).concat(headings(manifest, HEADINGS));
    const result = paginatePlan({ manifest, overrides });
    expect(result.pages[0].headingText).toBe('One');
    expect(result.pages[1].headingText).toBe('One (continued)');
    for (const entry of result.overrides) expect(entry.text.trim().length).toBeGreaterThan(0);
    expectNoOverflow(result, manifest);
  });

  it('packs a new inline section into body room without overflowing the heading box', () => {
    // Flow boxes hold six lines. The next section starts inline, independent
    // of the one-line running-head box, and uses the remaining body capacity.
    const manifest = makeManifest({ headings: true, flowHeight: 180 });
    const overrides = bodies(manifest, [fullPage(0), words(30), '', '', '', '']).concat(headings(manifest, HEADINGS));
    const result = paginatePlan({ manifest, overrides });
    expect(result.pages[0].headingText).toBe('One');
    expect(result.pages[0].flowText).toContain(`${fullPage(0)}\n\nTwo\n`);
    expect(result.pages[0].usedHeight).toBe(180);
    expect(result.pages[1].headingText).toBe('Two (continued)');
    expectNoOverflow(result, manifest);
  });

  it('uses the heading slot only for the top section and later headings inline', () => {
    // Even a taller heading slot must not make the body break early.
    const manifest = makeManifest({ headings: true, flowHeight: 180, headingHeight: 60 });
    const overrides = bodies(manifest, [words(3), words(3, 4), '', '', '', '']).concat(headings(manifest, HEADINGS));
    const result = paginatePlan({ manifest, overrides });
    expect(result.pages[0].headingText).toBe('One');
    expect(result.pages[0].flowText).toBe(`${words(3)}\n\nTwo\n${words(3, 4)}`);
  });

  it('reports flow-underfull with a sane deficit when the manuscript is short', () => {
    const manifest = makeManifest();
    // Only one page of content: pages 3-6 are structurally empty.
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [fullPage(0), '', '', '', '', '']) });
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.code).toBe('flow-underfull');
    expect(issue.slotId).toBe('story-page3-body');
    expect(issue.pageLabel).toBe('PAGE_3');
    const deficit = Number(issue.message.match(/roughly (\d+) more characters/)?.[1]);
    expect(deficit).toBeGreaterThan(0);
  });

  it('reports flow-overflow with the surplus when the manuscript is too long', () => {
    const manifest = makeManifest();
    // Far more than six pages of text.
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [words(400)]) });
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0];
    expect(issue.code).toBe('flow-overflow');
    expect(issue.slotId).toBe('story-page7-body');
    expect(issue.pageLabel).toBe('PAGE_7');
    expect(Number(issue.message.match(/about (\d+) characters/)?.[1])).toBeGreaterThan(0);
    expect(result.pages.every((page) => page.filled)).toBe(true);
    expectNoOverflow(result, manifest);
    expectFilledToLastLine(result, manifest);
  });

  it('detects the underfull tail after packing six short headed sections', () => {
    const manifest = makeManifest({ headings: true, flowHeight: 180 });
    const result = paginatePlan({ manifest, overrides: bodies(manifest, HEADINGS.map(() => words(6))).concat(headings(manifest, HEADINGS)) });
    expect(result.pages.slice(0, 3).every((page) => page.filled)).toBe(true);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'flow-underfull', pageLabel: 'PAGE_5' })]);
    expectNoOverflow(result, manifest);
  });

  it('preserves every character of an overwide token without inserting spaces or newlines', () => {
    const manifest = makeManifest();
    const source = 'abcdefghijklmno'.repeat(16);
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [source]) });
    expect(result.pages.map((page) => page.flowText).join('')).toBe(source);
    expectNoOverflow(result, manifest);
  });

  it('does not duplicate later paragraphs when the first paragraph splits', () => {
    const manifest = makeManifest();
    const source = `${words(20)}\n${words(20, 4)}`;
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [source]) });
    expect(result.pages.map((page) => page.flowText).join(' ').split(/\s+/).filter(Boolean)).toEqual(source.split(/\s+/));
    expectNoOverflow(result, manifest);
  });

  it('reports a partially occupied non-final page as underfull', () => {
    const manifest = makeManifest();
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [words(3)]) });
    expect(result.pages[0].usedHeight).toBe(30);
    expect(result.pages[0].filled).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: 'flow-underfull', pageLabel: 'PAGE_2', slotId: 'story-page2-body' });
  });

  it('keeps an inline heading with its first body line but rejects the unused line', () => {
    const manifest = makeManifest({ headings: true });
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [words(6), words(40)]).concat(headings(manifest, HEADINGS)) });
    expect(result.pages[0].flowText).toBe(words(6));
    expect(result.pages[0].usedHeight).toBe(60);
    expect(result.pages[0].filled).toBe(false);
    expect(result.pages[1].headingText).toBe('Two');
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'flow-underfull', pageLabel: 'PAGE_2' }));
    expectFilledToLastLine(result, manifest);
    expectNoOverflow(result, manifest);
  });

  it.each([1, 2, 3])('rejects %s spare body lines behind a deferred multiline heading', (spareLines) => {
    const manifest = makeManifest({ headings: true, flowHeight: 180 });
    const titles = ['One', words(9), ...HEADINGS.slice(2)];
    const firstBody = words((6 - spareLines) * 3);
    expect(measureTextBlock(firstBody, 200, LEGACY_STYLE).lineCount).toBe(6 - spareLines);
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [firstBody, words(30)]).concat(headings(manifest, titles)) });
    expect(result.pages[0].flowText).toBe(firstBody);
    expect(result.pages[0].filled).toBe(false);
    expect(result.pages[1].headingText).toBe(titles[1]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'flow-underfull', pageLabel: 'PAGE_2' }));
    expectFilledToLastLine(result, manifest);
    expectNoOverflow(result, manifest);
  });

  it.each([
    [119.98, true],
    [119.995, false],
    [120, false],
    [120.02, false],
  ])('uses measured line capacity and tolerance at %s px', (flowHeight, filled) => {
    const manifest = makeManifest({ headings: true, flowHeight });
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [fullPage(0), words(40)]).concat(headings(manifest, HEADINGS)) });
    expect(result.pages[0].usedHeight).toBe(90);
    expect(result.pages[0].filled).toBe(filled);
    expectFilledToLastLine(result, manifest);
    expectNoOverflow(result, manifest);
  });

  it('allows only the final page to end early when the manuscript is exhausted', () => {
    const manifest = makeManifest({ headings: true, flowHeight: 180 });
    const texts = [...Array.from({ length: 5 }, (_, index) => words(18, index)), fullPage(0)];
    const result = paginatePlan({ manifest, overrides: bodies(manifest, texts).concat(headings(manifest, HEADINGS)) });
    expect(result.issues).toEqual([]);
    expect(result.pages.slice(0, -1).every((page) => page.filled)).toBe(true);
    expect(result.pages.at(-1)?.filled).toBe(false);
    expectFilledToLastLine(result, manifest);
    expectNoOverflow(result, manifest);
  });

  it('requests rebalancing rather than contradictory expansion when gaps and overflow coexist', () => {
    const manifest = makeManifest({ headings: true });
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [words(6), words(300)]).concat(headings(manifest, HEADINGS)) });
    expect(result.issues.map((issue) => issue.code)).toEqual(['flow-overflow', 'flow-underfull']);
    const feedback = result.issues.map((issue) => issue.message).join(' ');
    expect(feedback).toContain('Rebalance');
    expect(feedback).not.toContain('more characters');
    expect(feedback).not.toContain('completely full');
    expectFilledToLastLine(result, manifest);
    expectNoOverflow(result, manifest);
  });

  it('rejects the pictured Nomadic Village heading gaps and accepts expanded sections', () => {
    const manifest = buildManifestFromRows({ templateId: 'guide', templateVersion: 1, rows: elementSeeds(SEED_RECIPES[1]) }).manifest;
    const texts = [
      'Imagine setting out beside Lake Balaton with a small bag. Your next stop is a cottage among orchards; after that, perhaps a yurt near a meadow. Each place stands on its own, but a walk or cycle ride links it to another. This is the Nomadic Village: a network of independently funded Hunsteads beginning around Balaton in Hungary. Its homes need not share a street for people to feel part of something shared.',
      'A Hunstead is more than a bed for the night. One might restore a cottage and grow food; another might offer tiny houses, yurts or a campsite. Each takes its character from its land and the people who care for it. Regenerative food production, nature, communal facilities and creative spaces can sit beside accommodation. Members can choose where to rest, work, learn or meet rather than find the same experience at every stop.',
      ...Array.from({ length: 4 }, (_, section) => Array.from({ length: 13 }, (_, line) => `Section ${section + 3} offers useful detail ${line + 1}.`).join('\n')),
    ];
    const titles = ['A village made of places, paths and shared purpose', 'Every Hunstead offers a different reason to stay', ...HEADINGS.slice(2)];
    const overrides = bodies(manifest, texts).concat(headings(manifest, titles));
    const before = JSON.stringify({ manifest, overrides });
    const result = paginatePlan({ manifest, overrides });
    expect(result.pages.slice(0, 2).map((page) => page.usedHeight)).toEqual([420, 462]);
    expect(result.pages.slice(0, 2).map((page) => page.filled)).toEqual([false, false]);
    expect(result.pages.map((page) => page.flowText)).toEqual(texts);
    expect(result.pages.map((page) => page.headingText)).toEqual(titles);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'flow-underfull', pageLabel: 'PAGE_2' })]);
    expect(result.issues[0].message).toContain('PAGE_3');
    expect(result.issues[0].message).toContain('heading');
    expect(JSON.stringify({ manifest, overrides })).toBe(before);
    expectFilledToLastLine(result, manifest);
    expectNoOverflow(result, manifest);

    // Model a repair that adds substantive detail BEFORE the deferred headings.
    const expanded = texts.map((text, index) => index < 2
      ? text + '\n' + Array.from({ length: index === 0 ? 3 : 2 }, (_, line) => `Local residents share practical insight ${line + 1}.`).join('\n')
      : text);
    const repaired = paginatePlan({ manifest, overrides: bodies(manifest, expanded).concat(headings(manifest, titles)) });
    expect(repaired.issues).toEqual([]);
    expect(repaired.pages.every((page) => page.filled)).toBe(true);
    expect(repaired.pages.map((page) => page.flowText)).toEqual(expanded);
    expectFilledToLastLine(repaired, manifest);
    expectNoOverflow(repaired, manifest);
  });

  it('abbreviates a running head to measured heading capacity', () => {
    const manifest = makeManifest({ headings: true });
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [words(30)]).concat(headings(manifest, ['A long but meaningful section title'])) });
    const head = result.pages[1].headingText;
    expect(head).toBe('A long… (continued)');
    expect(measureTextBlock(head, 200, LEGACY_STYLE).height).toBeLessThanOrEqual(30);
    expectNoOverflow(result, manifest);
  });

  it('does not open a new page with a blank paragraph', () => {
    const manifest = makeManifest();
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [`${fullPage(0)}\n\n${words(6)}`]) });
    expect(result.pages[1].flowText.startsWith('\n')).toBe(false);
    expect(result.pages[1].flowText).toBe(words(6));
  });

  it('packs the reported guide manuscript to measured non-final capacity', () => {
    const manifest = buildManifestFromRows({ templateId: 'guide', templateVersion: 1, rows: elementSeeds(SEED_RECIPES[1]) }).manifest;
    const texts = [
      'The internet makes it easy to find information and hard, sometimes, to find company. We can know what strangers are doing across the world while missing the people and places just around the corner.\nOuternet starts with a different question: what if a social network helped you put your phone away? Its purpose is to make the real world more connected, accessible, sociable and rewarding.',
      'Outernet is map-first. Instead of an endless feed asking for more of your attention, it helps you discover places to go and things to do nearby. A coffee meetup, a shared table for work or a neighbourhood event becomes easier to find.\nThe screen is a starting point, not the destination. The useful part happens when a place on the map becomes a place where people meet.',
      'Outernet Cafés are participating physical venues: coffee shops, restaurants, pubs, hotels and other places where people naturally gather. They give local discovery a welcoming address.\nIf you have just moved to town, a coffee meetup can be an easier first step than trying to make friends from scratch. If you are visiting, a family-run restaurant may offer a more memorable evening than another familiar chain.',
      'Outernet Spaces are bookable places offered by venues and other locations for remote working, meetings, social activities, workshops and community events.\nA remote worker can choose company over another day at the kitchen table. A craftsperson can host a workshop. A quiet café can welcome people to tables that might otherwise sit empty. One available space can serve many different needs across a week.',
      'For someone feeling isolated, a nearby walking group or gardening meetup can make joining in feel possible. For a visitor, finding a local place to eat can turn an ordinary stop into a conversation.\nBusinesses benefit too. A village pub can bring neighbours together for a quiz night; an independent maker can meet customers through a workshop. Outernet helps people looking for somewhere to go find the places ready to welcome them.',
      'No single event can bring a whole community together. But a series of small invitations can change how a place feels: familiar faces at a shared table, new voices at a meeting, neighbours who recognise one another on the street.\nOuternet is built around those ordinary moments. By making local places and activities easier to discover, it aims to help more people take part in the life happening around them.',
    ];
    const titles = ['A social network that points beyond the screen', 'Start with a map, then step into the world', 'Outernet Cafés make room for a first hello', 'Outernet Spaces turn spare room into opportunity', 'A better day for people and local businesses', 'The strongest communities begin with showing up'];
    const result = paginatePlan({ manifest, overrides: bodies(manifest, texts).concat(headings(manifest, titles)) });
    expectNoOverflow(result, manifest);
    expect(result.pages.slice(0, -1).every((page) => page.filled)).toBe(true);
    expectFilledToLastLine(result, manifest);
  });

  it('reflows carried text into wider later frames instead of retaining the first width', () => {
    const manifest = makeManifest({ flowHeight: 180 });
    for (const page of interiorFlowPages(manifest).slice(1)) page.flow.box.width = 400;
    const source = words(100);
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [source]) });
    expect(result.pages[1].flowText.split(/\s+/).length).toBeGreaterThan(result.pages[0].flowText.split(/\s+/).length);
    expect(result.pages.map((page) => page.flowText).join(' ').split(/\s+/).filter(Boolean)).toEqual(source.split(/\s+/));
    expectNoOverflow(result, manifest);
  });

  it('packs the saved Michael Rizal story then rejects its genuinely short manuscript', () => {
    const manifest = buildManifestFromRows({ templateId: 'story', templateVersion: 1, rows: elementSeeds(SEED_RECIPES[0]) }).manifest;
    const texts = [
      `Michael knelt beside a tired patch of garden. The soil looked empty, but a voice said, "Look closer!" A small figure stepped from beneath a leaf. "I'm Zome. Come and meet your neighbours." Michael touched the earth, and suddenly the ground seemed full of paths.`,
      `Tiny creatures hurried through the soil. Fine fungal threads reached toward plant roots. "They help each other," said Zome. "The plant shares sugars it makes from sunlight. The fungus helps the plant reach water and nutrients." Michael grinned. "It's a neighbourhood under my shoes!"`,
      `Zome led Michael to a patch of bare, hard ground. Rain ran across it, carrying soil away. Nearby, roots and fallen leaves helped the earth soak up water. "Living soil can slow a rush of rain," Zome said. "But when we leave land bare or damage it again and again, those helpful neighbours struggle."`,
      `Michael wanted to help. He spread dry leaves over the bare soil and added finished compost to the garden bed. Zome suggested growing plants to keep roots in the ground, even between crops. "Little changes add up," said Zome. Michael imagined worms finding shelter beneath the leaves.`,
      `"Could a whole place change like this?" Michael asked. Zome nodded. "That's the hope behind the Hunstead Project: to turn neglected places into spaces where people grow food, restore nature, share resources and learn together." Michael pictured neighbours bringing seeds, stories and willing hands.`,
      `Back at school, Michael had questions for his friends. Where does our food grow? What lives in the soil outside our classroom? What could we improve together? Zome's adventures could begin a three-week journey of discovery for children in schools. Michael picked up a magnifying glass. "Let's start here."`,
    ];
    const result = paginatePlan({ manifest, overrides: bodies(manifest, texts) });
    expect(result.pages.map((page) => page.usedHeight)).toEqual([588, 588, 588, 42, 0, 0]);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'flow-underfull', pageLabel: 'PAGE_5' })]);
    expect(result.pages.map((page) => page.flowText).join(' ').split(/\s+/).filter(Boolean)).toEqual(texts.join(' ').split(/\s+/));
    expectNoOverflow(result, manifest);
  });

  it('is deterministic: repeated runs paginate identically', () => {
    const manifest = makeManifest({ headings: true });
    const overrides = bodies(manifest, [words(25), words(25, 3), words(25, 6), words(25, 1), words(25, 4), words(25, 7)]).concat(
      headings(manifest, HEADINGS.map((heading) => `Chapter ${heading}`)),
    );
    const first = paginatePlan({ manifest, overrides });
    const second = paginatePlan({ manifest, overrides });
    expect(second).toEqual(first);
  });
});

describe('paginatePlan (guided Lora measurement)', () => {
  it('fills split paragraphs without turning soft wraps into indented, spaced paragraphs', { timeout: 20000 }, () => {
    const manifest = makeManifest({ guided: true, flowHeight: 340 });
    for (const page of interiorFlowPages(manifest)) {
      page.flow.style = { ...page.flow.style, paragraphGap: 1, firstLineIndent: 1.5 };
    }
    const source = words(90);
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [source]) });
    const page = result.pages[0];
    expect(page.flowText).not.toContain('\n');
    expect(page.usedHeight + GUIDED_STYLE.fontSize * GUIDED_STYLE.lineHeight).toBeGreaterThan(340);
    expect(result.pages.map((entry) => entry.flowText).join(' ').split(/\s+/).filter(Boolean)).toEqual(source.split(/\s+/));
    expectNoOverflow(result, manifest);
  });

  it('does not mistake a paragraph gap for a full page when the manuscript ends', () => {
    const manifest = makeManifest({ guided: true, flowHeight: 240 });
    for (const page of interiorFlowPages(manifest)) page.flow.style = { ...page.flow.style, paragraphGap: 4 };
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [words(9)]) });
    expect(result.pages[0].usedHeight + GUIDED_STYLE.fontSize * GUIDED_STYLE.lineHeight).toBeLessThan(240);
    expect(result.pages[0].filled).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: 'flow-underfull', pageLabel: 'PAGE_2' });
  });

  it('rejects spare lines when paragraph spacing prevents the next paragraph from starting', () => {
    const manifest = makeManifest({ guided: true, flowHeight: 240 });
    for (const page of interiorFlowPages(manifest)) page.flow.style = { ...page.flow.style, paragraphGap: 4 };
    const source = `${words(9)}\n${words(20, 3)}`;
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [source]) });
    expect(result.pages[0].flowText).toBe(words(9));
    expect(result.pages[1].flowText).not.toBe('');
    expect(result.pages[0].filled).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: 'flow-underfull', pageLabel: 'PAGE_2' });
    expect(result.pages.map((page) => page.flowText).join(' ').split(/\s+/).filter(Boolean)).toEqual(source.split(/\s+/));
    expectFilledToLastLine(result, manifest);
    expectNoOverflow(result, manifest);
  });

  it('keeps a guided inline heading attached without accepting its preceding gap', () => {
    const manifest = makeManifest({ headings: true, guided: true, flowHeight: 340, headingHeight: 40 });
    for (const page of interiorFlowPages(manifest)) page.flow.style = { ...page.flow.style, paragraphGap: 1, firstLineIndent: 1.5 };
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [words(9), words(30)]).concat(headings(manifest, HEADINGS)) });
    expect(result.pages[0].flowText).toBe(words(9));
    expect(result.pages[0].filled).toBe(false);
    expect(result.pages[1].headingText).toBe('Two');
    expect(result.issues[0]).toMatchObject({ code: 'flow-underfull', pageLabel: 'PAGE_2' });
    expectFilledToLastLine(result, manifest);
    expectNoOverflow(result, manifest);
  });

  // The guided path parses the Lora design font and lays out real glyphs, which
  // is far heavier than the legacy estimate; give it headroom under full-suite load.
  it('paginates through the design-text layout engine without overflow', { timeout: 20000 }, () => {
    const manifest = makeManifest({ headings: true, guided: true, flowHeight: 240, headingHeight: 40 });
    const overrides = bodies(manifest, [words(80), words(80, 5), words(80, 2), words(80, 7), words(80, 3), words(80, 8)]).concat(
      headings(manifest, HEADINGS.map((heading) => `Chapter ${heading}`)),
    );
    const result = paginatePlan({ manifest, overrides });
    expect(result.pages.some((page) => page.filled)).toBe(true);
    expectNoOverflow(result, manifest);
    const first = paginatePlan({ manifest, overrides });
    expect(first).toEqual(result);
  });
});
