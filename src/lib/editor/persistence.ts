import { PAGE_LABELS, type PageLabel } from '@/lib/constants';
import { editorSceneSchema } from './schema';

export type DocumentPart = 'title' | PageLabel;
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
export type DocumentSeed = Record<DocumentPart, { value: string; revision: number }>;
export type SaveTransport = (part: DocumentPart, value: string, revision: number) => Promise<number>;
type Part = { value: string; saved: string; revision: number; flight?: Promise<void>; error?: Error };
export type Recovery = Partial<DocumentSeed>;

export class DraftPersistence {
  private parts = new Map<DocumentPart, Part>();
  private disposed = false;
  private storageWarned = false;
  readonly recoveryKey: string;
  constructor(readonly id: string, userId: string, seed: DocumentSeed,
    private transport: SaveTransport, private onState: (state: SaveState) => void,
    private storage?: Storage, private onStorageError: () => void = () => {}) {
    this.recoveryKey = `titchybook-recovery:${userId}:${id}`;
    for (const key of ['title', ...PAGE_LABELS] as DocumentPart[]) {
      this.parts.set(key, { ...seed[key], saved: seed[key].value });
    }
  }
  get dirty() { return [...this.parts.values()].some(p => p.value !== p.saved || !!p.flight); }
  revision(part: DocumentPart) { return this.parts.get(part)!.revision; }
  set(part: DocumentPart, value: string) {
    const entry = this.parts.get(part)!;
    if (this.disposed || entry.value === value) return;
    entry.value = value;
    this.notify();
  }
  private storageFailure() {
    if (!this.storageWarned) { this.storageWarned = true; this.onStorageError(); }
  }
  readRecovery(): Recovery | null {
    try {
      const raw = this.storage?.getItem(this.recoveryKey);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (data.version !== 1 || !data.parts || typeof data.parts !== 'object') return null;
      const result: Recovery = {};
      for (const key of ['title', ...PAGE_LABELS] as DocumentPart[]) {
        const part = data.parts[key];
        if (!part) continue;
        if (typeof part.value !== 'string' || !Number.isInteger(part.revision) || part.revision < 0) return null;
        if (key === 'title') { if (part.value.length > 120) return null; }
        else editorSceneSchema.parse(JSON.parse(part.value));
        result[key] = { value: part.value, revision: part.revision };
      }
      return Object.keys(result).length ? result : null;
    } catch { this.storageFailure(); return null; }
  }
  restore(recovery: Recovery) {
    for (const key of ['title', ...PAGE_LABELS] as DocumentPart[]) {
      const recovered = recovery[key];
      if (!recovered) continue;
      const part = this.parts.get(key)!;
      part.value = recovered.value;
      // Never relabel stale recovery with a newer server revision.
      if (part.value !== part.saved) part.revision = recovered.revision;
    }
    this.notify();
  }
  clearRecovery() {
    try { this.storage?.removeItem(this.recoveryKey); } catch { this.storageFailure(); }
  }
  private notify() {
    if (this.disposed) return;
    const entries = [...this.parts.values()];
    this.onState(entries.some(p => p.error) ? 'error' : entries.some(p => p.flight) ? 'saving' : this.dirty ? 'idle' : 'saved');
    const parts: Recovery = {};
    for (const [key, part] of this.parts) {
      if (part.value !== part.saved || part.flight) parts[key] = { value: part.value, revision: part.revision };
    }
    try {
      if (Object.keys(parts).length) this.storage?.setItem(this.recoveryKey, JSON.stringify({ version: 1, parts }));
      else this.storage?.removeItem(this.recoveryKey);
    } catch { this.storageFailure(); }
  }
  flush(part: DocumentPart): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Draft changed; save canceled'));
    const entry = this.parts.get(part)!;
    if (entry.flight) return entry.flight;
    entry.error = undefined;
    if (entry.saved === entry.value) { this.notify(); return Promise.resolve(); }
    const run = async () => {
      // Coalesce edits made while a previous request was in flight.
      while (entry.value !== entry.saved) {
        const sent = entry.value;
        const revision = await this.transport(part, sent, entry.revision);
        if (this.disposed) throw new Error('Draft changed; save canceled');
        entry.revision = revision;
        entry.saved = sent;
        this.notify();
      }
    };
    entry.flight = run().catch(error => { entry.error = error; throw error; }).finally(() => {
      entry.flight = undefined;
      this.notify();
    });
    this.notify();
    return entry.flight;
  }
  async flushAll() {
    // Wait for every part, including successful acknowledgments after another fails.
    const results = await Promise.allSettled((['title', ...PAGE_LABELS] as DocumentPart[]).map(key => this.flush(key)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  dispose() { this.disposed = true; }
}

export const draftPointerStorage = {
  getItem(key: string) { try { return browserStorage()?.getItem(key) ?? null; } catch { return null; } },
  setItem(key: string, value: string) { try { browserStorage()?.setItem(key, value); } catch { /* The document recovery path reports storage failures. */ } },
  removeItem(key: string) { try { browserStorage()?.removeItem(key); } catch { /* A stale pointer is validated when reopened. */ } },
};

export function browserStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
