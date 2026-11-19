import { afterEach, expect, it, vi } from 'vitest';
import { format } from 'node:util';
const send = vi.hoisted(() => vi.fn());
vi.mock('resend', () => ({ Resend: class { emails = { send }; } }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); send.mockReset(); vi.resetModules(); });
it('returns false for provider-reported errors without sending live email', async () => {
  vi.stubEnv('RESEND_API_KEY', 'test-only');
  send.mockResolvedValue({ data: null, error: { message: 'Rejected' } });
  const { sendWelcomeEmail, sendPasswordResetEmail } = await import('@/lib/email');
  expect(await sendWelcomeEmail({ to: 'test@example.invalid', name: 'Test' })).toBe(false);
  expect(await sendPasswordResetEmail({ to: 'test@example.invalid', resetUrl: 'http://localhost/reset' })).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
});

it('escapes welcome names and reset URLs without losing accents', async () => {
  vi.stubEnv('RESEND_API_KEY', 'test-only');
  send.mockResolvedValue({ data: { id: 'fixture' }, error: null });
  const { sendWelcomeEmail, sendPasswordResetEmail } = await import('@/lib/email');
  await sendWelcomeEmail({ to: 'test@example.invalid', name: 'Émilie <img src=x> & "friends"' });
  const html = send.mock.calls[0][0].html as string;
  expect(html).toContain('Émilie &lt;img src=x&gt; &amp; &quot;friends&quot;');
  expect(html).not.toContain('<img src=x>');
  await sendPasswordResetEmail({ to: 'test@example.invalid', resetUrl: 'http://localhost/reset?token=fixture&source="test"' });
  expect(send.mock.calls[1][0].html).toContain('token=fixture&amp;source=&quot;test&quot;');
});

it('minimizes logs when a provider exception includes personal data or tokens', async () => {
  vi.stubEnv('RESEND_API_KEY', 'test-only');
  const { sendWelcomeEmail, sendPasswordResetEmail, sendContactEmail } = await import('@/lib/email');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  send.mockRejectedValue(new Error('private@example.invalid secret-reset-token'));
  expect(await sendWelcomeEmail({ to: 'private@example.invalid', name: 'Private name' })).toBe(false);
  expect(await sendPasswordResetEmail({ to: 'private@example.invalid', resetUrl: 'http://localhost/reset?token=secret-reset-token' })).toBe(false);
  expect(await sendContactEmail({ name: 'Private name', email: 'private@example.invalid', topic: 'general', message: 'Private message' })).toBe(false);
  // Format each call the way Node would print it: JSON.stringify drops
  // Error.message, which console.error does render.
  const output = [warn, error, log, info].flatMap(spy => spy.mock.calls.map(args => format(...args))).join('\n');
  expect(output).not.toContain('private@example.invalid');
  expect(output).not.toContain('secret-reset-token');
  expect(output).not.toContain('Private name');
});
