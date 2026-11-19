import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertScratch, canonicalCheck, cleanupOwnedScratch, restoreTarget, scratchNames } from '../../scripts/test-restore.mts';

afterEach(() => vi.unstubAllEnvs());
const raw = 'postgresql://test:local_only@127.0.0.1:55433/app_test';
const token = '0123456789abcdef01234567';
describe('disposable restore target safety', () => {
  it('permits only generated, owned scratch names and never the base database', () => {
    const names = scratchNames(token); const owned = new Set(Object.values(names));
    expect(names.source).not.toBe(names.restored);
    expect(() => assertScratch(names.source, 'app_test', owned)).not.toThrow();
    expect(() => assertScratch(names.restored, 'app_test', owned)).not.toThrow();
    expect(() => assertScratch(names.source, names.source, owned)).toThrow();
    expect(() => assertScratch('app_test', 'app_test', owned)).toThrow();
    expect(() => assertScratch(names.source, 'app_test', new Set())).toThrow();
    expect(() => assertScratch(`batch7_restore_test_${token}_other`, 'app_test', owned)).toThrow();
    expect(() => scratchNames('arbitrary;sql')).toThrow();
  });
  it('attempts every acknowledged owned database when one cleanup fails and retains only failures', () => {
    const names = scratchNames(token); const created = new Set(Object.values(names));
    const drop = vi.fn((name: string) => { if (name === names.source) throw new Error('Occupied scratch'); });
    expect(() => cleanupOwnedScratch('app_test', created, drop)).toThrow(/Owned scratch cleanup failed/);
    expect(drop.mock.calls.map(([name]) => name)).toEqual([names.source, names.restored]);
    expect([...created]).toEqual([names.source]);
    cleanupOwnedScratch('app_test', created, () => undefined);
    expect(created.size).toBe(0);
  });
  it('validates the entire cleanup set before any drop, even when an invalid name comes last', () => {
    const names = scratchNames(token);
    for (const invalid of ['app_test', 'unrelated', names.source]) {
      const created = new Set([names.restored, invalid]); const drop = vi.fn();
      const base = invalid === names.source ? names.source : 'app_test';
      expect(() => cleanupOwnedScratch(base, created, drop)).toThrow(/non-owned scratch/);
      expect(drop).not.toHaveBeenCalled();
    }
  });
  it.each(['55432', '55433'])('accepts the explicit local PG target on %s', port => {
    const url = raw.replace('55433', port); vi.stubEnv('TEST_DATABASE_URL', url);
    expect(restoreTarget(url).major).toBe(port === '55432' ? 16 : 17);
  });
  it.each([
    raw.replace('127.0.0.1', 'remote.example.invalid'),
    raw.replace('app_test', 'application'),
    raw.replace('55433', '5432'),
    raw.replace('test:local_only@', ''),
    raw + '?host=remote.example.invalid',
    raw + '?schema=neon_auth',
    raw + '?sslmode=disable',
    raw + '?options=unsafe',
  ])('fails closed before any Docker operation for %s', url => {
    vi.stubEnv('TEST_DATABASE_URL', url);
    expect(() => restoreTarget(url)).toThrow();
  });
  it('cannot silently substitute another supplied URL', () => {
    vi.stubEnv('TEST_DATABASE_URL', raw);
    expect(() => restoreTarget(raw.replace('app_test', 'other_test'))).toThrow();
  });
  it('normalizes only observed associative AND grouping, not changed financial rules', () => {
    const range = '(("expectedMinorAmount" >= 1) AND ("expectedMinorAmount" <= 99999999)) AND';
    const flat = '("expectedMinorAmount" >= 1) AND ("expectedMinorAmount" <= 99999999) AND';
    expect(canonicalCheck('Order.Order_charge_range', range)).toBe(flat);
    expect(canonicalCheck('PaymentAttempt.PaymentAttempt_charge_valid', range)).toBe(flat);
    expect(canonicalCheck('Other.constraint', range)).toBe(range);
    for (const changed of [range.replace(' AND', ' OR'), range.replace('>= 1', '>= 0'), range.replace('99999999', '99999998')]) {
      expect(canonicalCheck('Order.Order_charge_range', changed)).toBe(changed);
    }
  });
  it('allows only the public schema override', () => {
    vi.stubEnv('TEST_DATABASE_URL', raw + '?schema=public');
    expect(restoreTarget(raw + '?schema=public').base).toBe('app_test');
  });
});
