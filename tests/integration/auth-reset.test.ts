import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { cleanupFixtures, createUser, db } from '../fixtures/database';
import { prisma } from '@/lib/prisma';
import { POST as reset } from '@/app/api/auth/reset-password/route';

vi.mock('bcryptjs', async () => {
  const actual = await vi.importActual<typeof import('bcryptjs')>('bcryptjs');
  return { ...actual, hash: vi.fn(actual.hash) };
});
let ip: string;
const request = (token: string, password = 'Reset-fixture-password-42!') => new Request('http://localhost/api/auth/reset-password', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ token, password }),
});
async function issued(expiresAt = new Date(Date.now() + 60_000)) {
  const user = await createUser();
  const token = randomBytes(32).toString('hex');
  await db.user.update({ where: { id: user.id }, data: { passwordResetToken: createHash('sha256').update(token).digest('hex'), passwordResetExpires: expiresAt } });
  return { user, token };
}
beforeEach(async () => {
  ip = `sprint-reset-${randomUUID()}`;
  const actual = await vi.importActual<typeof import('bcryptjs')>('bcryptjs');
  vi.mocked(hash).mockImplementation(actual.hash);
});
afterEach(async () => {
  await cleanupFixtures();
  await db.rateLimitBucket.deleteMany({ where: { bucketKey: `reset:ip:${ip}` } });
});
afterAll(async () => { await prisma.$disconnect(); await db.$disconnect(); });

it('redeems once, clears both fields, validates the new password, and refuses reuse', async () => {
  const { user, token } = await issued();
  expect((await reset(request(token))).status).toBe(200);
  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(await compare('Reset-fixture-password-42!', stored.passwordHash)).toBe(true);
  expect(stored.passwordResetToken).toBeNull();
  expect(stored.passwordResetExpires).toBeNull();
  expect((await reset(request(token, 'Second-password-42!'))).status).toBe(400);
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(stored.passwordHash);
});

it('admits exactly one concurrent redemption after both contenders pass lookup', async () => {
  const { user, token } = await issued();
  const actual = await vi.importActual<typeof import('bcryptjs')>('bcryptjs');
  let release!: () => void;
  const bothLocated = new Promise<void>(resolve => { release = resolve; });
  let arrivals = 0;
  vi.mocked(hash).mockImplementation(async value => {
    if (++arrivals === 2) release();
    await bothLocated;
    return actual.hash(value, 10);
  });
  const passwords = ['First-concurrent-password-42!', 'Second-concurrent-password-42!'];
  const results = await Promise.all(passwords.map(value => reset(request(token, value))));
  expect(arrivals).toBe(2);
  expect(results.map(r => r.status).sort()).toEqual([200, 400]);
  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(await compare(passwords[results.findIndex(r => r.status === 200)], stored.passwordHash)).toBe(true);
  expect(await compare(passwords[results.findIndex(r => r.status === 400)], stored.passwordHash)).toBe(false);
});

it('refuses an expired or unknown token without changing the password', async () => {
  const { user, token } = await issued(new Date(0));
  expect((await reset(request(token))).status).toBe(400);
  expect((await reset(request(randomBytes(32).toString('hex')))).status).toBe(400);
  expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
});

it.each(['expiry', 'replacement'])('rechecks %s after hashing without consuming newer recovery authority', async condition => {
  const { user, token } = await issued();
  const newerToken = createHash('sha256').update('newer-fixture-token').digest('hex');
  vi.mocked(hash).mockImplementationOnce(async () => {
    await db.user.update({ where: { id: user.id }, data: condition === 'expiry'
      ? { passwordResetExpires: new Date(0) } : { passwordResetToken: newerToken } });
    return 'unused-fixture-hash';
  });
  expect((await reset(request(token))).status).toBe(400);
  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  expect(stored.passwordHash).toBe(user.passwordHash);
  if (condition === 'replacement') expect(stored.passwordResetToken).toBe(newerToken);
});
