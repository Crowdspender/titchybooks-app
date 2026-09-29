import { describe, expect, it, vi } from 'vitest';

// Keep the QA module hermetic: estimateTextFits/isRetryable are pure, but the
// module imports prisma and s3 at load time.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/s3', () => ({ objectExists: vi.fn(async () => true) }));

import { estimateTextFits, isRetryable, type QaReport } from '@/lib/ai/qa';
import { textElement } from '../fixtures/scenes';
import type { EditorElement } from '@/lib/editor/schema';

type TextEl = Extract<EditorElement, { type: 'text' }>;

function text(overrides: Partial<TextEl> & { text: string }): TextEl {
  return { ...(textElement('t', overrides.text) as TextEl), ...overrides };
}

describe('estimateTextFits', () => {
  it('passes short text within a large box', () => {
    const el = text({ text: 'Hello', width: 250, height: 90, fontSize: 32, lineHeight: 1.2, fontFamily: 'Arial', letterSpacing: 0 });
    expect(estimateTextFits(el)).toBe(true);
  });

  it('fails long text that overflows the box', () => {
    const el = text({ text: 'x'.repeat(200), width: 250, height: 90, fontSize: 32, lineHeight: 1.2, fontFamily: 'Arial', letterSpacing: 0 });
    expect(estimateTextFits(el)).toBe(false);
  });

  it('accounts for hard line breaks', () => {
    const el = text({ text: 'a\nb\nc\nd\ne', width: 250, height: 90, fontSize: 32, lineHeight: 1.2, fontFamily: 'Arial', letterSpacing: 0 });
    // 5 lines * 38.4px = 192px > 90 * 1.1
    expect(estimateTextFits(el)).toBe(false);
  });

  it('treats an unknown font with the default width factor', () => {
    const el = text({ text: 'Hello', width: 400, height: 200, fontSize: 24, lineHeight: 1.2, fontFamily: 'Trebuchet MS', letterSpacing: 0 });
    expect(estimateTextFits(el)).toBe(true);
  });
});

describe('isRetryable', () => {
  const check = (id: string, passed: boolean, severity: 'terminal' | 'retry') => ({ id, passed, detail: '', severity });

  it('is retryable when a retry-severity check failed', () => {
    const report: QaReport = { passed: false, checks: [check('text-fits', false, 'retry')] };
    expect(isRetryable(report)).toBe(true);
  });

  it('is not retryable when only terminal checks failed', () => {
    const report: QaReport = { passed: false, checks: [check('dpi', false, 'terminal')] };
    expect(isRetryable(report)).toBe(false);
  });

  it('is not retryable when everything passed', () => {
    const report: QaReport = { passed: true, checks: [check('text-fits', true, 'retry')] };
    expect(isRetryable(report)).toBe(false);
  });
});
