import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma } from '@/lib/prisma';
import { claimRenderJob, processRenderJob } from '@/lib/pdf/render-job';

let stopping = false;
const pollMs = Number(process.env.RENDER_WORKER_POLL_MS ?? 2000);
if (!Number.isFinite(pollMs) || pollMs < 100) throw new Error('Invalid RENDER_WORKER_POLL_MS');
function stop() {
  if (stopping) return;
  stopping = true;
  // Unfinished work is reclaimed when its lease expires.
  setTimeout(() => process.exit(0), 30_000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
async function main() {
  while (!stopping) {
    try {
      const job = await claimRenderJob();
      if (!job) { await sleep(pollMs); continue; }
      console.info(JSON.stringify({ event: 'render-claimed', jobId: job.id, attempt: job.attempts }));
      await processRenderJob(job);
      console.info(JSON.stringify({ event: 'render-attempt-finished', jobId: job.id }));
    } catch {
      console.error('Render worker operation failed; reconnecting');
      await sleep(pollMs);
    }
  }
  await prisma.$disconnect();
}
void main().catch(() => { process.exitCode = 1; });
