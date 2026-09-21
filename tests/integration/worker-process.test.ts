import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, expect, it } from 'vitest';
import { db, createDraft, createUser, cleanupFixtures } from '../fixtures/database';
import { testEnvironment } from '../../scripts/test-environment.mts';

afterAll(async () => { await cleanupFixtures(); await db.$disconnect(); });
it('a separate Node process recovers a persisted job without a web request', async () => {
  expect(await db.renderJob.count({ where: { status: { in: ['QUEUED', 'PROCESSING'] } } })).toBe(0);
  const user = await createUser();
  const draft = await createDraft(user.id);
  // Invalid frozen input exercises the real worker without contacting storage.
  const job = await db.renderJob.create({ data: { submissionId: draft.id, inputSnapshot: { version: 99 } } });
  await db.submission.update({ where: { id: draft.id }, data: { status: 'PROCESSING' } });
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/workers/render-worker.ts'], {
    env: { ...testEnvironment(), RENDER_WORKER_POLL_MS: '100' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'exit');
  try {
    await expect.poll(async () => (await db.renderJob.findUniqueOrThrow({ where: { id: job.id } })).status, { timeout: 20000 }).toBe('FAILED');
    expect(output).toContain('render-claimed');
    expect((await db.submission.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('FAILED');
    expect((await db.renderJob.findUniqueOrThrow({ where: { id: job.id } })).attempts).toBe(1);
  } finally {
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(deadline); }
  }
}, 30000);
