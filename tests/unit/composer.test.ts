import { describe, expect, it } from 'vitest';
import { buildOverridesByPage, validatePlanAgainstSlots, validatePlanAgainstTemplate, type TemplateTextSlot } from '@/lib/ai/composer';
import type { ContentPlan } from '@/lib/ai/content-plan';
import { textElement } from '../fixtures/scenes';
import type { DesignText } from '@/lib/editor/design-fonts';

const slots: TemplateTextSlot[] = [
  { id: 'cover-title', pageLabel: 'FRONT_COVER' },
  { id: 'page2-body', pageLabel: 'PAGE_2' },
  { id: 'page3-body', pageLabel: 'PAGE_3' },
];

function plan(overrides: Array<{ templateElementId: string; text: string }>, title = 'T'): ContentPlan {
  return { version: 1, title, overrides };
}

describe('validatePlanAgainstTemplate', () => {
  it('accepts a plan that only references known slots', () => {
    const result = validatePlanAgainstTemplate(
      plan([{ templateElementId: 'cover-title', text: 'Hi' }]),
      slots,
    );
    expect(result.ok).toBe(true);
  });

  it('uses actual guided glyph layout even when content is within the character budget', () => {
    const guidedElement: DesignText = { ...textElement('page2-body') as DesignText, typographyVersion: 1, fontFamily: 'Lora', fontSize: 33, width: 580, height: 70 };
    const guidedSlots = [{ id: 'page2-body', pageLabel: 'PAGE_2', maxChars: 10000, guidedElement }];
    expect(validatePlanAgainstTemplate(plan([{ templateElementId: 'page2-body', text: 'Beside the quiet sea.' }]), guidedSlots).ok).toBe(true);
    const result = validatePlanAgainstTemplate(plan([{ templateElementId: 'page2-body', text: 'The waves rolled toward the harbor. '.repeat(20) }]), guidedSlots);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'guided-overflow', slotId: 'page2-body' }));
  });

  it('rejects missing guided glyphs without replacing content or fonts', () => {
    const guidedElement: DesignText = { ...textElement('page2-body') as DesignText, typographyVersion: 1, fontFamily: 'Lora' };
    const input = plan([{ templateElementId: 'page2-body', text: 'A story with ĸ' }]);
    const result = validatePlanAgainstTemplate(input, [{ id: 'page2-body', pageLabel: 'PAGE_2', guidedElement }]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'guided-font', slotId: 'page2-body' }));
    expect(input.overrides[0].text).toBe('A story with ĸ');
    expect(guidedElement.fontFamily).toBe('Lora');
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

describe('validatePlanAgainstSlots flow option', () => {
  it('suppresses over-budget only for the paginated flow slots', () => {
    const budgeted: TemplateTextSlot[] = [
      { id: 'page2-body', pageLabel: 'PAGE_2', maxChars: 10 },
      { id: 'page3-body', pageLabel: 'PAGE_3', maxChars: 10 },
    ];
    const long = plan([
      { templateElementId: 'page2-body', text: 'Twenty-plus characters of finished copy.' },
      { templateElementId: 'page3-body', text: 'Twenty-plus characters of finished copy.' },
    ]);
    // Without the flow option both slots fail the per-slot budget.
    expect(validatePlanAgainstSlots(long, budgeted).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'over-budget', slotId: 'page2-body' }),
        expect.objectContaining({ code: 'over-budget', slotId: 'page3-body' }),
      ]),
    );
    // With it, only the non-flow slot keeps the per-slot check: the paginator
    // decides what a flow slot holds, so its budget is meaningless.
    const result = validatePlanAgainstSlots(long, budgeted, { flow: { flowSlotIds: new Set(['page2-body']) } });
    expect(result.issues).toEqual([expect.objectContaining({ code: 'over-budget', slotId: 'page3-body' })]);
  });

  it('suppresses guided-overflow for flow slots while glyph guards still apply', () => {
    const guidedElement: DesignText = { ...textElement('page2-body') as DesignText, typographyVersion: 1, fontFamily: 'Lora', fontSize: 33, width: 580, height: 70 };
    const guidedSlots: TemplateTextSlot[] = [{ id: 'page2-body', pageLabel: 'PAGE_2', maxChars: 10000, guidedElement }];
    const longText = 'The waves rolled toward the harbor. '.repeat(20);
    // Baseline: the same text overflows the guided box without the option.
    expect(validatePlanAgainstSlots(plan([{ templateElementId: 'page2-body', text: longText }]), guidedSlots).issues)
      .toContainEqual(expect.objectContaining({ code: 'guided-overflow', slotId: 'page2-body' }));
    expect(validatePlanAgainstSlots(plan([{ templateElementId: 'page2-body', text: longText }]), guidedSlots, { flow: { flowSlotIds: new Set(['page2-body']) } }).ok).toBe(true);
    // A missing glyph is still rejected even for a paginated flow slot.
    const glyphs = validatePlanAgainstSlots(plan([{ templateElementId: 'page2-body', text: 'A story with ĸ' }]), guidedSlots, { flow: { flowSlotIds: new Set(['page2-body']) } });
    expect(glyphs.issues).toContainEqual(expect.objectContaining({ code: 'guided-font', slotId: 'page2-body' }));
  });

  it('still rejects placeholders, empty text and unsupported glyphs in flow slots', () => {
    const flowOptions = { flow: { flowSlotIds: new Set(['page2-body']) } };
    expect(validatePlanAgainstSlots(plan([{ templateElementId: 'page2-body', text: 'TODO: finish this scene' }]), slots, flowOptions).issues)
      .toContainEqual(expect.objectContaining({ code: 'placeholder-todo-marker', slotId: 'page2-body' }));
    expect(validatePlanAgainstSlots(plan([{ templateElementId: 'page2-body', text: 'Rain falls on the harbor \u{1F30A}' }]), slots, flowOptions).issues)
      .toContainEqual(expect.objectContaining({ code: 'unsupported-glyph', slotId: 'page2-body' }));
    expect(validatePlanAgainstSlots(plan([{ templateElementId: 'page2-body', text: '   ' }]), slots, flowOptions).issues)
      .toContainEqual(expect.objectContaining({ code: 'empty-text', slotId: 'page2-body' }));
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
