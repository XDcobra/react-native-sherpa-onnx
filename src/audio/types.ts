import type { FileSource } from '../fileio/types';
import type { PipelineAudioBufferIdSource } from '../audiobuffer/types';

/**
 * Supported output formats for audio save operations.
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
 * Input for audio save operations.
 *
 * - PipelineAudioBufferIdSource: save an existing offline or finalized live buffer.
 * - FileSource: direct file-to-file encode (no buffer registry involvement).
 */
export type AudioSaveInput = PipelineAudioBufferIdSource | FileSource;

/**
 * Progress event emitted during audio save operations.
 */
export interface AudioSaveProgressEvent {
  /** Unique operation identifier for correlation. */
  operationId: string;
  /** Current phase: "decode" (file-backed/FileSource input), "encode", or "finalize". */
  phase: 'decode' | 'encode' | 'finalize';
  /** Frames processed so far in current phase. */
  framesProcessed: number;
  /** Estimated total frames (0 if unknown). */
  totalFramesEstimate: number;
  /** Progress percentage 0–100 (0 when total unknown). */
  percent: number;
}

/**
 * Options for audio save operations.
 */
export interface SaveAudioOptions {
  /**
   * Target sample rate. Semantics depend on format:
   * - WAV:  0 or omitted = source's native sample rate. Explicit value = resample.
   * - MP3:  0 = 44100 (default). Allowed: 32000, 44100, 48000.
   * - Opus/WEBM/MKV/OGG: 0 = 48000 (default). Allowed: 8000, 12000, 16000, 24000, 48000.
   * - FLAC/AAC/M4A: 0 = source's native rate. Explicit value = resample.
   */
  outputSampleRateHz?: number;

  /**
   * Encoding quality hint for lossy formats.
   * Mapped to format-specific internal settings:
   * - MP3:  low=64kbps, medium=128kbps, high=192kbps
   * - AAC:  low=64kbps, medium=128kbps, high=192kbps
   * - Opus: low=24kbps, medium=64kbps, high=128kbps
   * Ignored for lossless formats (WAV, FLAC).
   * Overridden by explicit `bitrate` if both are set.
   */
  quality?: 'low' | 'medium' | 'high';

  /**
   * Target bitrate in kbps for lossy formats.
   * Takes precedence over `quality` if both are specified.
   * Ignored for lossless formats (WAV, FLAC).
   * 0 or omitted = use `quality` mapping or codec default.
   */
  bitrate?: number;

  /** AbortSignal to cancel the save operation. */
  signal?: AbortSignal;

  /** Progress callback — wired to native "audioSaveProgress" events. */
  onProgress?: (event: AudioSaveProgressEvent) => void;
}

/**
 * Error codes for audio save operations.
 * String values use the `AUDIO_SAVE_*` prefix.
 */
export const AudioSaveErrorCode = {
  /** Input argument is invalid (bad buffer ID format, invalid FileSource). */
  INVALID_ARGUMENT: 'AUDIO_SAVE_INVALID_ARGUMENT',
  /** Buffer not found in native registry. */
  BUFFER_NOT_FOUND: 'AUDIO_SAVE_BUFFER_NOT_FOUND',
  /** Live buffer is still in recording state — must be finalized first. */
  BUFFER_NOT_FINALIZED: 'AUDIO_SAVE_BUFFER_NOT_FINALIZED',
  /** Live buffer reference became invalid after ownership transfer/disposal. */
  BUFFER_INVALIDATED: 'AUDIO_SAVE_BUFFER_INVALIDATED',
  /** Buffer contains zero samples. */
  BUFFER_EMPTY: 'AUDIO_SAVE_BUFFER_EMPTY',
  /** Source file not found or not readable (FileSource input). */
  SOURCE_NOT_FOUND: 'AUDIO_SAVE_SOURCE_NOT_FOUND',
  /** Unsupported format or format unavailable. */
  UNSUPPORTED_FORMAT: 'AUDIO_SAVE_UNSUPPORTED_FORMAT',
  /** Invalid outputSampleRateHz for the requested format. */
  INVALID_SAMPLE_RATE: 'AUDIO_SAVE_INVALID_SAMPLE_RATE',
  /** Invalid quality or bitrate value. */
  INVALID_QUALITY: 'AUDIO_SAVE_INVALID_QUALITY',
  /** Native encoding/conversion error. */
  ENCODE_ERROR: 'AUDIO_SAVE_ENCODE_ERROR',
  /** Output file could not be written. */
  FILE_WRITE_ERROR: 'AUDIO_SAVE_FILE_WRITE_ERROR',
  /** Destination resolved to an invalid/empty output path. */
  DESTINATION_INVALID: 'AUDIO_SAVE_DESTINATION_INVALID',
  /** Operation was cancelled via AbortSignal. */
  CANCELLED: 'AUDIO_SAVE_CANCELLED',
} as const;

export type AudioSaveErrorCodeValue =
  (typeof AudioSaveErrorCode)[keyof typeof AudioSaveErrorCode];

// ── Pipeline Audio Session Types ──────────────────────────────────────────

/**
 * Audio profile describing the current session profile.
 * - 'inactive': No audio owners registered.
 * - 'playback': At least one PCM player active, no mic.
 * - 'duplex': Mic capture active (implies PlayAndRecord on iOS).
 */
export type PipelineAudioProfile = 'inactive' | 'playback' | 'duplex';

/**
 * Configuration for the pipeline audio session coordinator.
 */
export interface PipelineAudioSessionConfig {
  /**
   * If true, the audio session remains active even when no owners are registered.
   * On iOS this prevents AVAudioSession deactivation; on Android it holds AudioFocus.
   * Default: false.
   */
  keepActiveWhenIdle?: boolean;
}

/**
 * Route preference for the pipeline audio session.
 * Device IDs are platform-specific:
 * - iOS: AVAudioSessionPortDescription.UID or special ids like 'ios_builtin_speaker', 'ios_builtin_receiver'.
 * - Android: AudioDeviceInfo.id (numeric string).
 */
export interface PipelineAudioRoutePreference {
  /** Preferred input device ID (mic). Null/undefined = system default. */
  inputDeviceId?: string | null;
  /** Preferred output device ID (speaker). Null/undefined = system default. */
  outputDeviceId?: string | null;
}

/** Unified audio device metadata for input/output route listing. */
export interface PipelineAudioDeviceInfo {
  /** Stable id for selection calls (platform-native device id/uid). */
  id: string;
  /** Human readable device name. */
  name: string;
  /** Normalized kind (built_in_mic, built_in_speaker, bluetooth, usb, ...). */
  kind: string;
  /** True when this device is currently active for the corresponding route. */
  selected: boolean;
  /** True when this is the platform/default fallback route. */
  default: boolean;
  /** Whether explicit selection is supported for this device on this platform. */
  canSelect: boolean;
}

/**
 * Snapshot of the current pipeline audio session state.
 */
export interface PipelineAudioSessionState {
  /** Whether the audio session is currently active. */
  active: boolean;
  /** Current computed profile. */
  profile: PipelineAudioProfile;
  /** Number of active mic owners. */
  activeMicOwners: number;
  /** Number of active PCM player owners. */
  activePcmOwners: number;
  /** Currently configured preferred input device ID, or null. */
  preferredInputDeviceId: string | null;
  /** Currently configured preferred output device ID, or null. */
  preferredOutputDeviceId: string | null;
  /** Currently routed input device ID, or null. */
  currentInputDeviceId: string | null;
  /** Currently routed output device ID, or null. */
  currentOutputDeviceId: string | null;
}
