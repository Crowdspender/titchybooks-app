// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftPersistence, type DocumentSeed, type SaveTransport } from '@/lib/editor/persistence';
import { PAGE_LABELS } from '@/lib/constants';
import { createEmptyEditorScene } from '@/lib/editor/schema';
import { sceneWithText } from '../fixtures/scenes';
import { undoHistory, redoHistory } from '@/lib/editor/history';

function seed(revision = 0): DocumentSeed {
  return Object.fromEntries(['title', ...PAGE_LABELS].map(key => [key, {
    value: key === 'title' ? 'Original' : JSON.stringify(createEmptyEditorScene()), revision,
  }])) as DocumentSeed;
}
function delayed<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function coordinator(transport: SaveTransport, revision = 0) {
  const state = vi.fn();
  const draft = new DraftPersistence('draft', 'owner', seed(revision), transport, state, localStorage);
  return { draft, state };
}
afterEach(() => { localStorage.clear(); vi.useRealTimers(); });

describe('document persistence', () => {
  it('serializes and coalesces writes using acknowledged revisions', async () => {
    const first = delayed<number>();
    const transport = vi.fn<SaveTransport>().mockReturnValueOnce(first.promise).mockResolvedValueOnce(2);
    const { draft } = coordinator(transport);
    draft.set('title', 'First');
    const flight = draft.flush('title');
    draft.set('title', 'Intermediate');
    draft.set('title', 'Latest');
    expect(draft.flush('title')).toBe(flight);
    expect(transport).toHaveBeenCalledTimes(1);
    first.resolve(1);
    await flight;
    expect(transport.mock.calls).toEqual([['title', 'First', 0], ['title', 'Latest', 1]]);
    expect(draft.dirty).toBe(false);
    expect(localStorage.getItem(draft.recoveryKey)).toBeNull();
  });

  it('keeps recovery when an edit is reverted while its save is in flight', async () => {
    const late = delayed<number>();
    const transport = vi.fn<SaveTransport>().mockReturnValueOnce(late.promise).mockResolvedValueOnce(2);
    const { draft } = coordinator(transport);
    draft.set('title', 'Temporary');
    const flight = draft.flush('title');
    draft.set('title', 'Original');
    expect(draft.readRecovery()?.title).toEqual({ value: 'Original', revision: 0 });
    late.resolve(1);
    await flight;
    expect(transport).toHaveBeenLastCalledWith('title', 'Original', 1);
    expect(draft.dirty).toBe(false);
    expect(draft.readRecovery()).toBeNull();
  });

  it('flushes title and every dirty page before resolving', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<SaveTransport>((_part, _value, revision) => new Promise(resolve => setTimeout(() => resolve(revision + 1), 100)));
    const { draft } = coordinator(transport);
    draft.set('title', 'All eight');
    for (const label of PAGE_LABELS) draft.set(label, JSON.stringify(sceneWithText(label)));
    const done = vi.fn();
    const flush = draft.flushAll().then(done);
    expect(transport).toHaveBeenCalledTimes(9);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    await flush;
    expect(done).toHaveBeenCalledOnce();
    expect(draft.dirty).toBe(false);
  });

  it('retains failed content while acknowledging other pages, then retries', async () => {
    const transport = vi.fn<SaveTransport>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(1);
    const { draft, state } = coordinator(transport);
    draft.set('title', 'Recover me');
    draft.set('PAGE_7', JSON.stringify(sceneWithText('last page')));
    await expect(draft.flushAll()).rejects.toThrow('offline');
    expect(state).toHaveBeenLastCalledWith('error');
    expect(draft.readRecovery()).toEqual({ title: { value: 'Recover me', revision: 0 } });
    await draft.flushAll();
    expect(draft.dirty).toBe(false);
  });

  it('does not publish stale responses or erase recovery after disposal', async () => {
    const late = delayed<number>();
    const { draft, state } = coordinator(() => late.promise);
    draft.set('title', 'Old draft edits');
    const flight = draft.flush('title');
    draft.dispose();
    const calls = state.mock.calls.length;
    late.resolve(1);
    await expect(flight).rejects.toThrow('Draft changed');
    expect(state).toHaveBeenCalledTimes(calls);
    expect(draft.readRecovery()?.title?.value).toBe('Old draft edits');
  });

  it('keeps the stale base revision on recovery instead of overwriting a newer tab', async () => {
    const { draft: first } = coordinator(async () => 1);
    first.set('title', 'Local work');
    const transport = vi.fn<SaveTransport>().mockRejectedValue(new Error('409 conflict'));
    const { draft: reopened } = coordinator(transport, 4);
    reopened.restore(reopened.readRecovery()!);
    await expect(reopened.flushAll()).rejects.toThrow('409');
    expect(transport).toHaveBeenCalledWith('title', 'Local work', 0);
    expect(reopened.dirty).toBe(true);
    expect(reopened.readRecovery()?.title?.value).toBe('Local work');
  });

  it('scopes recovery by owner and draft, validates it, and supports discard', () => {
    const { draft } = coordinator(async () => 1);
    draft.set('PAGE_2', JSON.stringify(sceneWithText('page two')));
    const other = new DraftPersistence('draft', 'other', seed(), async () => 1, vi.fn(), localStorage);
    expect(other.readRecovery()).toBeNull();
    expect(draft.readRecovery()?.PAGE_2).toBeDefined();
    localStorage.setItem(draft.recoveryKey, JSON.stringify({ version: 1, parts: { PAGE_2: { value: '{}', revision: 0 } } }));
    expect(draft.readRecovery()).toBeNull();
    draft.clearRecovery();
    expect(localStorage.length).toBe(0);
  });

  it('continues server saves when storage is unavailable, warning only once', async () => {
    const warn = vi.fn();
    const storage = { setItem() { throw new Error('quota'); }, removeItem() { throw new Error('blocked'); } } as unknown as Storage;
    const draft = new DraftPersistence('draft', 'owner', seed(), async () => 1, vi.fn(), storage, warn);
    draft.set('title', 'One');
    draft.set('title', 'Two');
    await draft.flushAll();
    expect(warn).toHaveBeenCalledOnce();
    expect(draft.dirty).toBe(false);
  });
});

it('undo and redo round-trip the actual current document', () => {
  const current = { title: 'New', pages: ['a', 'b'] };
  const previous = { title: 'Old', pages: ['a'] };
  const undone = undoHistory({ past: [previous], present: previous, future: [] }, current)!;
  expect(undone.present).toEqual(previous);
  const redone = redoHistory(undone, previous)!;
  expect(redone.present).toEqual(current);
  expect(redone.past).toEqual([previous]);
});
