import { afterEach, expect, it, vi } from 'vitest';

type Session = { user: { id: string; email: string; role: string } };
type SessionArgs = { session: Session; token: { id: string; role: string } };
const captured = vi.hoisted(() => ({ callback: null as null | ((args: SessionArgs) => Promise<Session>), user: vi.fn() }));
vi.mock('next-auth', () => ({ default: (config: { callbacks: { session: (args: SessionArgs) => Promise<Session> } }) => {
  captured.callback = config.callbacks.session;
  return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() };
} }));
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: captured.user } } }));
import '@/auth';
afterEach(() => { captured.user.mockReset(); });
const args = (role = 'ADMIN'): SessionArgs => ({ session: { user: { id: '', email: 'fixture@example.invalid', role } }, token: { id: 'fixture-user', role } });

it('replaces an old ADMIN claim with the current database USER role', async () => {
  captured.user.mockResolvedValue({ role: 'USER' });
  expect((await captured.callback!(args())).user).toMatchObject({ id: 'fixture-user', role: 'USER' });
  expect(captured.user).toHaveBeenCalledWith({ where: { id: 'fixture-user' }, select: { role: true } });
});
it('preserves current administrator access and sees promotion without trusting the old JWT', async () => {
  captured.user.mockResolvedValue({ role: 'ADMIN' });
  expect((await captured.callback!(args('USER'))).user.role).toBe('ADMIN');
});
it('does not grant deleted accounts the stale administrator role', async () => {
  captured.user.mockResolvedValue(null);
  expect((await captured.callback!(args())).user.role).toBe('USER');
});
it('fails closed when authority cannot be checked', async () => {
  captured.user.mockRejectedValue(new Error('Database unavailable'));
  await expect(captured.callback!(args())).rejects.toThrow('Database unavailable');
});
