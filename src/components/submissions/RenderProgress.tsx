'use client';
import { useEffect, useEffectEvent, useState } from 'react';

type RenderStatus = {
  submissionStatus: string;
  jobStatus: string | null;
  job?: { attempts: number; maxAttempts: number; nextAttemptAt?: string; errorMessage?: string | null } | null;
};
export default function RenderProgress({ submissionId, status, onChange }: {
  submissionId: string; status: string; onChange: () => void;
}) {
  const [progress, setProgress] = useState<RenderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [cycle, setCycle] = useState(0);
  const notify = useEffectEvent(() => onChange());
  useEffect(() => {
    if (status !== 'PROCESSING' && !(status === 'FAILED' && cycle > 0)) return;
    let stopped = false;
    let terminal = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const started = Date.now();
    const eligible = () => !stopped && !terminal && !document.hidden && navigator.onLine;
    const poll = async () => {
      if (!eligible()) return;
      const request = new AbortController();
      controller = request;
      const deadline = setTimeout(() => request.abort(), 10000);
      try {
        const response = await fetch(`/api/submissions/${submissionId}/render-status`, { signal: request.signal, cache: 'no-store' });
        if (!response.ok) throw new Error('Status is temporarily unavailable. Reconnecting…');
        const data = await response.json() as RenderStatus;
        if (stopped || request.signal.aborted) return;
        setProgress(data);
        setError(null);
        if (data.submissionStatus !== 'PROCESSING') { terminal = true; notify(); }
      } catch {
        if (!stopped && !request.signal.aborted) setError('Status is temporarily unavailable. Reconnecting…');
      } finally {
        clearTimeout(deadline);
        if (controller === request) {
          controller = undefined;
          if (eligible()) timer = setTimeout(() => { void poll(); }, Date.now() - started < 30000 ? 2000 : 5000);
        }
      }
    };
    const resume = () => {
      clearTimeout(timer);
      controller?.abort();
      controller = undefined;
      if (eligible()) void poll();
    };
    void poll();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', resume);
    return () => {
      stopped = true; clearTimeout(timer); controller?.abort();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', resume);
    };
  }, [submissionId, status, cycle]);

  async function retry() {
    setRetrying(true); setError(null);
    try {
      const response = await fetch(`/api/submissions/${submissionId}/pdf`, { method: 'POST' });
      if (!response.ok) throw new Error('Retry could not be queued. Please try again.');
      setProgress({ submissionStatus: 'PROCESSING', jobStatus: 'QUEUED' });
      setCycle(value => value + 1);
      onChange();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Retry failed'); }
    finally { setRetrying(false); }
  }
  const current = status === 'PROCESSING' || (status === 'FAILED' && cycle > 0)
    ? progress?.submissionStatus ?? status : status;
  const label = current === 'PROCESSING'
    ? progress?.jobStatus === 'PROCESSING' ? 'Rendering your booklet…'
    : (progress?.job?.attempts ?? 0) > 0 ? 'Retrying rendering shortly…' : 'Queued for rendering…'
    : current === 'PENDING' ? 'Rendering complete — awaiting review'
    : current === 'FAILED' ? 'Rendering failed' : '';
  if (!label) return null;
  return <div className="mt-2 text-xs" aria-live="polite" role="status">
    <p>{label}{progress?.job && current === 'PROCESSING' ? ` (${progress.job.attempts}/${progress.job.maxAttempts} attempts)` : ''}</p>
    {error && <p role="alert">{error}</p>}
    {current === 'FAILED' && <button className="btn btn-outline btn-sm mt-2" onClick={retry} disabled={retrying}>{retrying ? 'Queuing…' : 'Retry rendering'}</button>}
  </div>;
}
