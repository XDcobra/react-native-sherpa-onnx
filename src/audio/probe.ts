import SherpaOnnx from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';

export type AudioFileDurationProbe = {
  durationMs: number;
  isExact: boolean;
};

/**
 * Probe audio file duration from container metadata (no decode).
 * Returns null when the probe fails so callers can degrade gracefully.
 */
export async function probeAudioFileDuration(
  source: FileSource
): Promise<AudioFileDurationProbe | null> {
  try {
    const result = await SherpaOnnx.probeAudioFileDuration(source as object);
    if (
      !result ||
      typeof result.durationMs !== 'number' ||
      !Number.isFinite(result.durationMs) ||
      result.durationMs <= 0
    ) {
      return null;
    }
    return {
      durationMs: result.durationMs,
      isExact: Boolean(result.isExact),
    };
  } catch {
    return null;
  }
}
