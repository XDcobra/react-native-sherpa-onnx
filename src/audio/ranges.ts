import type { AudioTimeRange } from './types';
import { AudioSaveErrorCode } from './types';

/**
 * Validate and merge overlapping/touching ranges.
 * Returns `undefined` when omitted/empty (encode full input).
 * @throws {Error} `AUDIO_SAVE_INVALID_RANGE` — NaN or inverted range.
 */
export function normalizeAudioTimeRanges(
  ranges?: ReadonlyArray<AudioTimeRange> | null
): AudioTimeRange[] | undefined {
  if (ranges == null || ranges.length === 0) {
    return undefined;
  }

  const sorted: AudioTimeRange[] = [];
  for (const raw of ranges) {
    const startMs = Number(raw?.startMs);
    const endMs = Number(raw?.endMs);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    ) {
      throw Object.assign(
        new Error(
          `${AudioSaveErrorCode.INVALID_RANGE}: each range requires finite startMs < endMs (exclusive end)`
        ),
        { code: AudioSaveErrorCode.INVALID_RANGE }
      );
    }
    sorted.push({ startMs, endMs });
  }

  sorted.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: AudioTimeRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (!last || r.startMs > last.endMs) {
      merged.push({ startMs: r.startMs, endMs: r.endMs });
    } else if (r.endMs > last.endMs) {
      last.endMs = r.endMs;
    }
  }
  return merged;
}
