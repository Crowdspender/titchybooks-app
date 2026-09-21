export interface HistoryState<T> { past: T[]; present: T | null; future: T[] }
export function undoHistory<T>(history: HistoryState<T>, current: T): HistoryState<T> | null {
  if (!history.past.length) return null;
  return { past: history.past.slice(0, -1), present: history.past[history.past.length - 1], future: [current, ...history.future] };
}
export function redoHistory<T>(history: HistoryState<T>, current: T): HistoryState<T> | null {
  if (!history.future.length) return null;
  return { past: [...history.past, current], present: history.future[0], future: history.future.slice(1) };
}
