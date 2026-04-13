/**
 * Supported output formats for audio conversion.
 * WAV is always 16-bit signed PCM.
 */
export type AudioOutputFormat =
  | 'wav'
  | 'mp3'
  | 'flac'
  | 'aac'
  | 'm4a'
  | 'opus'
  | 'webm'
  | 'mkv'
  | 'ogg';

/**
 * Options for audio conversion operations.
 */
export interface AudioConversionOptions {
  /**
   * Target sample rate. Semantics depend on format:
   * - WAV:  0 or omitted = buffer's native sample rate. Explicit value = resample.
   * - MP3:  0 = 44100 (default). Allowed: 32000, 44100, 48000.
   * - Opus/WEBM/MKV/OGG: 0 = 48000 (default). Allowed: 8000, 12000, 16000, 24000, 48000.
   * - FLAC/AAC/M4A: 0 = buffer's native rate. Explicit value = resample.
   */
  outputSampleRateHz?: number;
  /** AbortSignal to cancel conversion. */
  signal?: AbortSignal;
  /** Progress callback. */
  onProgress?: (event: import('../fileio/types').FileIOProgressEvent) => void;
}

/**
 * Error codes for audio conversion operations.
 */
export const ConversionErrorCode = {
  /** Buffer ID does not match expected pattern (off_UUID / live_UUID). */
  INVALID_ARGUMENT: 'CONVERSION_INVALID_ARGUMENT',
  /** Buffer not found in native registry. */
  BUFFER_NOT_FOUND: 'CONVERSION_BUFFER_NOT_FOUND',
  /** Live buffer is still in recording state — must be finalized first. */
  BUFFER_NOT_FINALIZED: 'CONVERSION_BUFFER_NOT_FINALIZED',
  /** Buffer contains zero samples. */
  BUFFER_EMPTY: 'CONVERSION_BUFFER_EMPTY',
  /** Unsupported format or format unavailable. */
  UNSUPPORTED_FORMAT: 'CONVERSION_UNSUPPORTED_FORMAT',
  /** Invalid outputSampleRateHz for the requested format. */
  INVALID_SAMPLE_RATE: 'CONVERSION_INVALID_SAMPLE_RATE',
  /** FFmpeg encoding/conversion error. */
  CONVERT_ERROR: 'CONVERSION_CONVERT_ERROR',
  /** Output file could not be written. */
  FILE_WRITE_ERROR: 'CONVERSION_FILE_WRITE_ERROR',
} as const;

export type ConversionErrorCodeValue =
  (typeof ConversionErrorCode)[keyof typeof ConversionErrorCode];
