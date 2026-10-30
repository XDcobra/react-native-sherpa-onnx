import type { VideoPreviewSnapshot } from './types';

function interpolate(
  snap: VideoPreviewSnapshot,
  nativeTs: number,
  now: number
): number {
  if (snap.state !== 'playing') return snap.positionMs;
  return snap.positionMs + Math.max(0, now - nativeTs);
}

/**
 * useSyncExternalStore compares snapshots with Object.is. A new `{ ...snap }`
 * on every getSnapshot call looks like a store change and React throws
 * "Maximum update depth exceeded". Reuse the last object when the visible
 * fields did not change.
 */
export function snapshotForStatusHook(
  snap: VideoPreviewSnapshot | null,
  nativeTs: number,
  now: number,
  smoothPosition: boolean,
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
  if (!smoothPosition) {
    cache.base = snap;
    cache.out = snap;
    return snap;
  }
  const positionMs = interpolate(snap, nativeTs, now);
  if (cache.out && cache.base === snap && cache.out.positionMs === positionMs) {
    return cache.out;
  }
  const out = positionMs === snap.positionMs ? snap : { ...snap, positionMs };
  cache.base = snap;
  cache.out = out;
  return out;
}
