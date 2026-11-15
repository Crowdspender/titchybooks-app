import { describe, expect, it } from 'vitest';
import { contentPlanSchema, parseContentPlan, normalizeContentPlan } from '@/lib/ai/content-plan';
import { bookPlanSystemPrompt, bookPlanUserPrompt, bookRepairSystemPrompt } from '@/lib/ai/book-prompts';
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
    expect(bookPlanUserPrompt('A story', [], { min: 2200, max: 2600 })).toContain('Aim for about 2400 characters');
    expect(bookRepairSystemPrompt()).toContain('measured room left, even if it contains text');
    expect(bookRepairSystemPrompt()).toContain('pastel palette');
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
});
