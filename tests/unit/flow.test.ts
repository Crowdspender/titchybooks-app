import { describe, expect, it } from 'vitest';
import { PAGE_LABELS, type PageLabel } from '@/lib/constants';
import { measureTextBlock, type TextStyle } from '@/lib/pdf/text-layout';
import {
  interiorFlowPages,
  interiorFlowSlotIds,
  interiorFlowWindow,
  paginatePlan,
  type PaginationResult,
} from '@/lib/ai/flow';
import { buildManifestFromRows, type AiTemplateManifest, type AiTemplateSlot } from '@/lib/ai/template-contract';
import { SEED_RECIPES, elementSeeds } from '../../prisma/seed-recipes';

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

/**
 * A page that filled by text placement (not by deferring a section start to
 * keep its heading whole) has no room for one more wrapped line.
 */
function expectFilledToLastLine(result: PaginationResult, manifest: AiTemplateManifest) {
  const pages = interiorFlowPages(manifest);
  result.pages.forEach((page, index) => {
    if (!page.filled) return;
    const slot = pages[index].flow;
    const oneMore = measureTextBlock(`${page.flowText}\n${words(1)}`, slot.box.width, styleOfSlot(slot)).height;
    expect(oneMore).toBeGreaterThan(slot.box.height);
  });
}

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

  it('returns null when the template has no interior flow pages', () => {
    const manifest = makeManifest();
    manifest.pages = manifest.pages.filter((page) => page.pageLabel === 'FRONT_COVER' || page.pageLabel === 'BACK_COVER');
    expect(interiorFlowWindow(manifest)).toBeNull();
  });
});

describe('interiorFlowSlotIds', () => {
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

  it('keeps an inline heading with its first body line and closes structurally', () => {
    const manifest = makeManifest({ headings: true });
    const result = paginatePlan({ manifest, overrides: bodies(manifest, [words(6), words(40)]).concat(headings(manifest, HEADINGS)) });
    expect(result.pages[0].flowText).toBe(words(6));
    expect(result.pages[0].usedHeight).toBe(60);
    expect(result.pages[0].filled).toBe(true);
    expect(result.pages[1].headingText).toBe('Two');
    expectNoOverflow(result, manifest);
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
