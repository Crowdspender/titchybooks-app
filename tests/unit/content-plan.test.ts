import { describe, expect, it } from 'vitest';
import { contentPlanSchema, parseContentPlan } from '@/lib/ai/content-plan';

describe('content plan contract', () => {
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
