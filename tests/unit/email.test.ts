import { afterEach, expect, it, vi } from 'vitest';
const send = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it('returns false for provider-reported errors without sending live email', async () => {
  vi.stubEnv('RESEND_API_KEY', 'test-only');
  send.mockResolvedValue({ data: null, error: { message: 'Rejected' } });
  const { sendWelcomeEmail, sendPasswordResetEmail } = await import('@/lib/email');
  expect(await sendWelcomeEmail({ to: 'test@example.invalid', name: 'Test' })).toBe(false);
  expect(await sendPasswordResetEmail({ to: 'test@example.invalid', resetUrl: 'http://localhost/reset' })).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
});
