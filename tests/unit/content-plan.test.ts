import { describe, expect, it } from 'vitest';
import { contentPlanSchema, parseContentPlan, normalizeContentPlan, parseContentRepair } from '@/lib/ai/content-plan';
import { bookPlanSystemPrompt, bookPlanUserPrompt, bookRepairSystemPrompt, bookRepairUserPrompt, type PromptSlot } from '@/lib/ai/book-prompts';
import { PRINT_PALETTE_IDS } from '@/lib/ai/print-palette';

describe('content plan contract', () => {
  const v2 = { version: 2, title: 'The Rainy Day', brief: { purpose: 'A story', audience: 'Families', tone: 'Warm', progression: 'Rain to sunshine' }, outline: [{ pageLabel: 'FRONT_COVER', purpose: 'Introduce the story' }], overrides: [] };

  it.each(PRINT_PALETTE_IDS)('preserves the qualified %s palette through normalization', (palette) => {
    expect(normalizeContentPlan({ ...v2, palette })?.palette).toBe(palette);
  });

  it('keeps older plans readable and discards unqualified model color choices', () => {
    expect(normalizeContentPlan(v2)).not.toBeNull();
    expect(normalizeContentPlan({ ...v2, palette: '#0f172a' })?.palette).toBeUndefined();
    expect(normalizeContentPlan({ ...v2, palette: 'navy' })?.palette).toBeUndefined();
  });

  it('prompts for qualified home-printer pastels and a concrete body target', () => {
    const prompt = bookPlanSystemPrompt();
    for (const palette of PRINT_PALETTE_IDS) expect(prompt).toContain(palette);
    expect(prompt).toContain('low-saturation pastels');
    expect(prompt).toContain('arbitrary hex colors');
    expect(bookPlanUserPrompt('A story', [], { min: 2200, max: 2600 })).toContain('Aim for about 2520 characters');
    expect(prompt).toContain('combined manuscript target takes precedence');
    expect(prompt).toContain('Never add manual line wrapping');
    expect(bookRepairSystemPrompt()).toContain('measured room left, even if a heading or paragraph boundary forced a break');
    expect(bookRepairSystemPrompt()).toContain('BEFORE the reported gaps, not just the ending');
    expect(bookRepairSystemPrompt()).toContain('rebalance into the gaps first and condense remaining excess instead of increasing total length');
    expect(bookRepairSystemPrompt()).toContain('pastel palette');
    expect(bookRepairSystemPrompt()).toContain('Do not return version, brief, outline, title, or palette fields');
    expect(bookRepairSystemPrompt()).toContain('EVERY slot id');
    expect(bookRepairSystemPrompt()).not.toContain('"brief": {...}');
  });

  it('carries the body target into repairs and distinguishes rejected manuscript from accepted slots', () => {
    const body: PromptSlot = { id: 'body', pageLabel: 'PAGE_2', role: 'body', purpose: 'Narrative', minChars: 40, maxChars: 580, fontFamily: 'Arial', fontSize: 28, boxWidth: 580, boxHeight: 620, flow: true };
    const prompt = bookRepairUserPrompt({
      concept: 'A story', title: 'A story', slots: [body], total: { min: 2200, max: 2600 },
      accepted: [{ templateElementId: 'body', text: 'Short manuscript' }, { templateElementId: 'cover', text: 'Accepted title' }],
      feedback: [{ slotId: 'body', pageLabel: 'PAGE_2', code: 'flow-underfull', detail: 'Write roughly 1000 more characters.' }],
    });
    expect(prompt).toContain('Aim for about 2520 characters');
    expect(prompt).toContain('body estimate (not a limit): 40-580');
    expect(prompt).toContain('use that total instead of this initial estimate');
    const [current, accepted] = prompt.split('Accepted content (keep it, do not resend):');
    expect(current).toContain('"body": "Short manuscript"');
    expect(accepted).not.toContain('Short manuscript');
    expect(accepted).toContain('"cover": "Accepted title"');
  });

  it('requires a full ending in new-layout generation and repair prompts', () => {
    const total = { min: 4400, max: 4400, fillAllInteriorPages: true as const };
    const prompts = [
      bookPlanUserPrompt('A full book', [], total),
      bookRepairUserPrompt({ concept: 'A full book', title: 'A full book', slots: [], accepted: [], feedback: [], total }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain('the final interior page must also fill to its last usable line');
      expect(prompt).not.toContain('only the final page may end early');
    }
    expect(bookPlanUserPrompt('A legacy book', [], { min: 2200, max: 2600 })).toContain('only the final page may end early');
  });

  it('gives section-specific expansion, condensation, and keep guidance ahead of the initial total', () => {
    const slot: PromptSlot = { id: 'long', pageLabel: 'PAGE_2', role: 'body', purpose: 'Narrative', minChars: 40, maxChars: 704, fontFamily: 'Arial', fontSize: 28, boxWidth: 580, boxHeight: 730, lineStep: 42, flow: true };
    const shape = { pageLabel: 'PAGE_2' as const, capacityHeight: 730, lineStep: 42 };
    const prompt = bookRepairUserPrompt({
      concept: 'A garden guide', title: 'A garden guide', slots: [slot, { ...slot, id: 'short', pageLabel: 'PAGE_3' }, { ...slot, id: 'full', pageLabel: 'PAGE_4' }],
      accepted: [], feedback: [{ slotId: 'long', pageLabel: 'PAGE_7', code: 'flow-overflow', detail: 'Text remains after page 7.' }],
      total: { min: 3800, max: 4200, fillAllInteriorPages: true },
      sectionTargets: [
        { ...shape, slotId: 'long', currentChars: 900, currentHeight: 924, targetMinChars: 665, targetMaxChars: 710, action: 'condense' },
        { ...shape, pageLabel: 'PAGE_3', slotId: 'short', currentChars: 300, currentHeight: 336, targetMinChars: 615, targetMaxChars: 652, action: 'expand' },
        { ...shape, pageLabel: 'PAGE_4', slotId: 'full', currentChars: 700, currentHeight: 714, targetMinChars: 700, targetMaxChars: 700, action: 'keep' },
        { ...shape, slotId: 'outside', currentChars: 700, currentHeight: 714, targetMinChars: 700, targetMaxChars: 700, action: 'keep' },
      ],
    });
    expect(prompt).toContain('about 17 naturally wrapped body lines');
    expect(prompt).toContain('CONDENSE by roughly 190-235 characters; aim for 665-710 characters');
    expect(prompt).toContain('EXPAND by roughly 315-352 characters; aim for 615-652 characters');
    expect(prompt).toContain('KEEP unchanged');
    expect(prompt).toContain('greater than 688px and at most 730px');
    expect(prompt).toContain('Combined revised body estimate: 1980-2062');
    expect(prompt).toContain('not their current paginated destinations');
    expect(prompt).toContain('not a hard acceptance limit');
    expect(prompt).not.toContain('"outside"');
    expect(bookRepairSystemPrompt()).toContain('do not take a prefix or cut off copy');
  });

  it('does not add balanced-section directives to a fixed-slot-only repair', () => {
    const prompt = bookRepairUserPrompt({ concept: 'A cover', title: 'A cover', slots: [], accepted: [], feedback: [] });
    expect(prompt).not.toContain('Measured raw-section targets (take precedence');
    expect(prompt).not.toContain('Combined revised body estimate');
  });

  it('accepts a well-formed plan', () => {
    const raw = JSON.stringify({
      title: 'The Rainy Day',
      overrides: [
        { templateElementId: 'cover-title', text: 'A rainy day' },
        { templateElementId: 'page2-body', text: 'Once upon a time...' },
      ],
    });
    const plan = parseContentPlan(raw);
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe('The Rainy Day');
    expect(plan!.overrides).toHaveLength(2);
  });

  it('rejects invalid JSON', () => {
    expect(parseContentPlan('not json')).toBeNull();
  });

  it('rejects a plan with no title', () => {
    expect(parseContentPlan(JSON.stringify({ overrides: [] }))).toBeNull();
  });

  it('rejects a title over 120 characters', () => {
    const plan = { title: 'x'.repeat(121), overrides: [] };
    expect(contentPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('rejects override text over 5000 characters', () => {
    const plan = {
      title: 'ok',
      overrides: [{ templateElementId: 'a', text: 'x'.repeat(5001) }],
    };
    expect(contentPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('rejects an override with an empty id', () => {
    const plan = { title: 'ok', overrides: [{ templateElementId: '', text: 'hi' }] };
    expect(contentPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('does not relax the full v2 plan contract to accommodate repair patches', () => {
    expect(normalizeContentPlan({ version: 2, title: 'A title', overrides: [] })).toBeNull();
  });
});

describe('content repair patch contract', () => {
  const targets = new Set(['body']);
  const overrides = [{ templateElementId: 'body', text: 'Revised manuscript.' }];

  it('accepts only replacement text without requiring any book metadata', () => {
    expect(parseContentRepair(JSON.stringify({ overrides }), targets)).toEqual({ success: true, data: { overrides } });
  });

  it('discards unsolicited legacy metadata, even if incomplete or invalid', () => {
    const raw = JSON.stringify({ version: 2, title: 'Changed title', brief: {}, outline: [], palette: 'peach', overrides });
    expect(parseContentRepair(raw, targets)).toEqual({ success: true, data: { overrides } });
  });

  it.each([
    ['malformed JSON', '{"overrides":', 'Invalid JSON'],
    ['missing array', '{}', 'overrides'],
    ['empty array', '{"overrides":[]}', 'overrides'],
    ['wrong text type', JSON.stringify({ overrides: [{ templateElementId: 'body', text: 42 }] }), 'overrides.0.text'],
    ['overlong text', JSON.stringify({ overrides: [{ templateElementId: 'body', text: 'x'.repeat(5001) }] }), 'overrides.0.text'],
    ['empty id', JSON.stringify({ overrides: [{ templateElementId: '', text: 'Copy' }] }), 'overrides.0.templateElementId'],
    ['duplicate id', JSON.stringify({ overrides: [...overrides, ...overrides] }), 'Duplicate override'],
    ['unrequested id', JSON.stringify({ overrides: [...overrides, { templateElementId: 'cover', text: 'Changed title' }] }), 'was not requested'],
  ])('rejects %s with actionable feedback', (_name, raw, detail) => {
    const result = parseContentRepair(raw, targets);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain(detail);
  });

  it('requires every requested slot even if the base plan already contains it', () => {
    const result = parseContentRepair(JSON.stringify({ overrides }), new Set(['body', 'closing']));
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Missing replacement for "closing"') });
  });

  it('retains the schema text boundary and bounds error output', () => {
    expect(parseContentRepair(JSON.stringify({ overrides: [{ templateElementId: 'body', text: 'x'.repeat(5000) }] }), targets).success).toBe(true);
    const result = parseContentRepair(JSON.stringify({ overrides: [{ templateElementId: 'x'.repeat(2000), text: 'Copy' }] }), targets);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.length).toBeLessThan(1100);
  });
});
