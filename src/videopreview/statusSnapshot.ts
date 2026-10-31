import type { VideoPreviewSnapshot } from './types';

/**
 * useSyncExternalStore compares snapshots with Object.is. Always return the
 * same object while the event-sourced snap reference is unchanged.
 */
export function snapshotForStatusHook(
  snap: VideoPreviewSnapshot | null,
  _nativeTs: number,
  _now: number,
  _smoothPosition: boolean,
  cache: {
    base: VideoPreviewSnapshot | null;
    out: VideoPreviewSnapshot | null;
  }
): VideoPreviewSnapshot | null {
  if (!snap) {
    cache.base = null;
    cache.out = null;
    return null;
  }
  if (cache.out && cache.base === snap) {
    return cache.out;
  }
  cache.base = snap;
  cache.out = snap;
  return snap;
}
