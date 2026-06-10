import SherpaOnnx from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';

export type AudioFileDurationProbe = {
  durationMs: number;
  isExact: boolean;
};

/** Detected container + primary audio codec (caller interprets). */
export type AudioFileContainerProbe = {
  inputFormatName: string;
  codecName: string;
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

/**
 * Probe container format and primary audio codec from file content (no PCM decode).
 * Uses FFmpeg auto-probe when needed so format is inferred from file content.
 * Returns null when the probe fails so callers can degrade gracefully.
 */
export async function probeAudioFileContainer(
  source: FileSource
): Promise<AudioFileContainerProbe | null> {
  try {
    const result = await SherpaOnnx.probeAudioFileContainer(source as object);
    const inputFormatName = result?.inputFormatName?.trim();
    const codecName = result?.codecName?.trim();
    if (!inputFormatName || !codecName) {
      return null;
    }
    return { inputFormatName, codecName };
  } catch {
    return null;
  }
}
