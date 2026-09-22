// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import RenderProgress from '@/components/submissions/RenderProgress';

const response = (submissionStatus = 'PROCESSING', jobStatus = 'QUEUED', attempts = 0) =>
  Response.json({ submissionStatus, jobStatus, job: { attempts, maxAttempts: 3 } });
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('polls until rendering completes, refreshes, and does not announce approval', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response('PENDING', 'COMPLETED'));
  vi.stubGlobal('fetch', fetch);
  const onChange = vi.fn();
  render(<RenderProgress submissionId="one" status="PROCESSING" onChange={onChange} />);
  await tick();
  expect(screen.getByRole('status').textContent).toContain('Queued');
  await tick(2000);
  expect(screen.getByRole('status').textContent).toContain('awaiting review');
  expect(screen.getByRole('status').textContent).not.toContain('Approved');
  expect(onChange).toHaveBeenCalledOnce();
  await tick(60000);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('pauses offline/hidden, resumes, and aborts on unmount', async () => {
  const fetch = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetch);
  const view = render(<RenderProgress submissionId="one" status="PROCESSING" onChange={vi.fn()} />);
  await tick();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  fireEvent.offline(window);
  await tick(10000);
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  fireEvent.online(window);
  await tick();
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  fireEvent(document, new Event('visibilitychange'));
  await tick(10000);
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  fireEvent(document, new Event('visibilitychange'));
  await tick();
  const signal = fetch.mock.calls.at(-1)![1].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await tick(10000);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('backs off after thirty seconds', async () => {
  const fetch = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetch);
  render(<RenderProgress submissionId="one" status="PROCESSING" onChange={vi.fn()} />);
  await tick(30000);
  const calls = fetch.mock.calls.length;
  await tick(4999);
  expect(fetch).toHaveBeenCalledTimes(calls);
  await tick(1);
  expect(fetch).toHaveBeenCalledTimes(calls + 1);
});

it('reconnects after a timed-out status request', async () => {
  const fetch = vi.fn().mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('timeout')));
  })).mockResolvedValue(response('PROCESSING', 'PROCESSING', 1));
  vi.stubGlobal('fetch', fetch);
  render(<RenderProgress submissionId="one" status="PROCESSING" onChange={vi.fn()} />);
  await tick(10000);
  expect((fetch.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
  await tick(2000);
  expect(screen.getByRole('status').textContent).toContain('Rendering your booklet');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('queues a failed render retry and displays queued feedback', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ jobId: 'new' }, { status: 202 })).mockResolvedValue(response());
  vi.stubGlobal('fetch', fetch);
  const onChange = vi.fn();
  render(<RenderProgress submissionId="one" status="FAILED" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry rendering' }));
  await tick();
  expect(fetch).toHaveBeenCalledWith('/api/submissions/one/pdf', { method: 'POST' });
  expect(screen.getByRole('status').textContent).toContain('Queued');
  expect(onChange).toHaveBeenCalledOnce();
});

it('does not retain awaiting-review text after the parent reports approval', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('PENDING', 'COMPLETED')));
  const view = render(<RenderProgress submissionId="one" status="PROCESSING" onChange={vi.fn()} />);
  await tick();
  view.rerender(<RenderProgress submissionId="one" status="APPROVED" onChange={vi.fn()} />);
  expect(screen.queryByRole('status')).toBeNull();
});
