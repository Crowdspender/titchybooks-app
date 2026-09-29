import { describe, expect, it } from 'vitest';
import { buildOverridesByPage, validatePlanAgainstTemplate, type TemplateTextSlot } from '@/lib/ai/composer';
import type { ContentPlan } from '@/lib/ai/content-plan';

const slots: TemplateTextSlot[] = [
  { id: 'cover-title', pageLabel: 'FRONT_COVER' },
  { id: 'page2-body', pageLabel: 'PAGE_2' },
  { id: 'page3-body', pageLabel: 'PAGE_3' },
];

function plan(overrides: Array<{ templateElementId: string; text: string }>, title = 'T'): ContentPlan {
  return { title, overrides };
}

describe('validatePlanAgainstTemplate', () => {
  it('accepts a plan that only references known slots', () => {
    const result = validatePlanAgainstTemplate(
      plan([{ templateElementId: 'cover-title', text: 'Hi' }]),
      slots,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown element id', () => {
    const result = validatePlanAgainstTemplate(
      plan([{ templateElementId: 'does-not-exist', text: 'Hi' }]),
      slots,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate overrides for the same element', () => {
    const result = validatePlanAgainstTemplate(
      plan([
        { templateElementId: 'cover-title', text: 'A' },
        { templateElementId: 'cover-title', text: 'B' },
      ]),
      slots,
    );
    expect(result.ok).toBe(false);
  });
});

describe('buildOverridesByPage', () => {
  it('groups sanitized text by page label', () => {
    const overrides = buildOverridesByPage(
      plan([
        { templateElementId: 'cover-title', text: 'The Title' },
        { templateElementId: 'page2-body', text: 'Body\u0007 text' },
      ]),
      slots,
    );
    expect(overrides).toEqual({
      FRONT_COVER: { 'cover-title': 'The Title' },
      PAGE_2: { 'page2-body': 'Body text' },
    });
  });

  it('never emits geometry, only text keyed by element id', () => {
    const overrides = buildOverridesByPage(
      plan([{ templateElementId: 'page3-body', text: 'x' }]),
      slots,
    );
    const value = overrides.PAGE_3['page3-body'];
    expect(typeof value).toBe('string');
    expect(JSON.stringify(overrides)).not.toMatch(/"(width|height|x|y|zIndex|rotation|opacity)":/);
  });

  it('drops overrides whose text sanitizes to empty', () => {
    const overrides = buildOverridesByPage(
      plan([{ templateElementId: 'cover-title', text: '\u0000\u0001' }]),
      slots,
    );
    expect(overrides).toEqual({});
  });

  it('ignores ids that are not slots (defensive)', () => {
    const overrides = buildOverridesByPage(
      plan([{ templateElementId: 'ghost', text: 'boo' }]),
      slots,
    );
    expect(overrides).toEqual({});
  });
});
