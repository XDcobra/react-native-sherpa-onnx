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
