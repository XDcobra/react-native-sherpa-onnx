/**
 * Pipeline audio buffer types for react-native-sherpa-onnx/audiobuffer.
 *
 * Two core buffer kinds:
 * - OfflinePcmBuffer: immutable, fully populated PCM data (from file, samples, or live snapshot)
 * - LivePcmBuffer: streaming, mutable PCM with recording/finished state machine
 */

import type { StreamEventSpec } from '../pipeline/streamEvents';
import type { Segment } from '../segment/segment';

// ========== Buffer Kinds ==========

export type PipelineBufferKind = 'offlinePcmBuffer' | 'livePcmBuffer';

// ========== Buffer States ==========

/** State of an offline buffer (always immutable). */
export type OfflineBufferState = 'immutable';

/** State of a live buffer. recording → finished (no reverse). */
export type LiveBufferState = 'recording' | 'finished';

// ========== Info Types ==========

/** Info returned by all pipeline audio buffer operations (offline). */
export interface OfflineAudioBufferInfo {
  bufferId: string;
  kind: 'offlinePcmBuffer';
  state: 'immutable';
  sampleRate: number;
  channelCount: number;
  numSamples: number;
  durationMs: number;
  /** Storage strategy: "ram" for heap-backed, "mmap" for memory-mapped file. */
  storageKind?: 'ram' | 'mmap';
}

/**
 * Strongly-typed reference returned by offline buffer creation functions.
 * Includes both metadata and branded handle.
 */
export interface OfflineAudioBufferRef {
  info: OfflineAudioBufferInfo;
  bufferId: OfflineBufferHandle;
}

/**
 * Strongly-typed reference returned by `createEmptyLiveAudioBuffer` (recording state).
 * Includes metadata, branded recording handle, and event unsubscribe.
 */
export interface LiveAudioBufferRef {
  info: LiveAudioBufferInfo;
  bufferId: LiveBufferHandleRecording;
  unsubscribeEvents: () => void;
}

/** Argument that resolves to an offline audio buffer native id. */
export type OfflineAudioBufferIdSource =
  | OfflineAudioBufferRef
  | OfflineBufferHandle
  | string;

/** Argument that resolves to a live audio buffer native id (recording or finished). */
export type LiveAudioBufferIdSource =
  | LiveAudioBufferRef
  | LiveBufferHandleRecording
  | LiveBufferHandleFinished
  | string;

/** Argument for APIs that accept any pipeline audio buffer (ref, last-fetched info, handle, or raw id). */
export type PipelineAudioBufferIdSource =
  | OfflineAudioBufferRef
  | LiveAudioBufferRef
  | PipelineAudioBufferInfo
  | OfflineBufferHandle
  | LiveBufferHandle
  | string;

/** Live audio buffer in `recording` state (mic, append, finalize input). */
export type LiveAudioBufferRecordingSource =
  | LiveAudioBufferRef
  | LiveBufferHandleRecording
  | string;

/** Info returned by all pipeline audio buffer operations (live). */
export interface LiveAudioBufferInfo {
  bufferId: string;
  kind: 'livePcmBuffer';
  state: LiveBufferState;
  sampleRate: number;
  channelCount: number;
  numSamples: number;
  durationMs: number;
  totalSamplesWritten: number;
  /** Ring cache evictions. Not data loss when spool is active. */
  ringEvictedSamples: number;
  hasActiveSpool: boolean;
}

/** Discriminated union of all pipeline audio buffer info types. */
export type PipelineAudioBufferInfo =
  | OfflineAudioBufferInfo
  | LiveAudioBufferInfo;

// ========== Branded Handle Types ==========

/**
 * Branded handle for an offline audio buffer.
 * Compile-time guard: only offline buffer IDs are accepted where OfflineBufferHandle is required.
 */
export type OfflineBufferHandle = string & {
  readonly __brand: 'OfflineBufferHandle';
};

/**
 * Branded handle for a live audio buffer in recording state.
 * STT-Streaming, PCM Player (live), Enhancement-Streaming accept this.
 */
export type LiveBufferHandleRecording = string & {
  readonly __brand: 'LiveBufferHandleRecording';
};

/**
 * Branded handle for a live audio buffer in finished state.
 * STT (offline), Alignment, Enhancement (offline) accept this.
 */
export type LiveBufferHandleFinished = string & {
  readonly __brand: 'LiveBufferHandleFinished';
};

/** Any live buffer handle (recording or finished). */
export type LiveBufferHandle =
  | LiveBufferHandleRecording
  | LiveBufferHandleFinished;

/** Any pipeline audio buffer handle. */
export type PipelineBufferHandle = OfflineBufferHandle | LiveBufferHandle;

// ========== Live Append Events ==========

/** Source that produced newly appended frames in a live buffer. */
export type LiveBufferAppendSource =
  | 'mic'
  | 'append'
  | 'append_offline'
  | 'file_ingest'
  | 'enhancement'
  | 'tts'
  | 'unknown'
  | 'mixed';

/** Producer-agnostic event: new frames were appended to a live buffer. */
export interface LiveAudioBufferFramesAppendedEvent {
  liveBufferId: string;
  source: LiveBufferAppendSource;
  sampleRate: number;
  frameCount: number;
  totalSamplesWritten: number;
}

/** Live-buffer related error event (for example mic capture failures). */
export interface LiveAudioBufferErrorEvent {
  liveBufferId?: string;
  message: string;
}

/** Callback set for live buffer append/error events. */
export interface LiveAudioBufferCallbacks {
  onFramesAppended?: (event: LiveAudioBufferFramesAppendedEvent) => void;
  onSegment?: (event: LiveAudioBufferSegmentEvent) => void;
  onError?: (event: LiveAudioBufferErrorEvent) => void;
}

export type AudioSegmentationMode = 'off' | 'manual' | 'auto';

export interface AudioSegmentationConfig {
  mode?: AudioSegmentationMode;
}

export interface LiveAudioBufferSegmentEvent {
  bufferId: string;
  segment: Segment;
  totalSegments: number;
}

// ========== Creation Options ==========

// ========== Retention Policy ==========

/**
 * Controls on-disk retention of appended samples.
 *
 * - 'auto' (default): spool exists for the session (native trim enforcement not implemented yet).
 * - 'session': spool retains every sample until buffer release.
 * - 'none': no spool; ring-only; lossless only if consumer never lags.
 * - { mode: 'maxSeconds', seconds, path? }: currently accepted but not trimmed yet; behaves like session retention.
 * - { mode: 'path', path, trim? }: explicit persistence path.
 */
export type LiveBufferRetention =
  | 'auto'
  | 'session'
  | 'none'
  | { mode: 'maxSeconds'; seconds: number; path?: string }
  | {
      mode: 'path';
      path: string;
      trim?: 'auto' | 'session' | { maxSeconds: number };
    };

/** Backpressure mode for producer append operations. */
export type AppendBackpressure = 'none' | 'block';

/** Options for creating an empty live audio buffer. */
export interface CreateEmptyLiveAudioBufferOptions {
  /** Sample rate in Hz (e.g. 16000, 44100). */
  sampleRate: number;
  /** Number of channels. Only 1 (mono) is supported. */
  channelCount?: number;
  /**
   * Duration of the in-memory ring cache in seconds. Default: 60.
   * Samples older than this may still be readable via spool.
   */
  ringSeconds?: number;
  /**
   * Controls on-disk retention of appended samples.
   * Default: 'auto'.
   */
  retention?: LiveBufferRetention;

  /**
   * High-frequency data-plane events for this live buffer.
   * - `framesAppended`: new PCM was appended (mic, spool, STT, etc.)
   * When `streamEvents.framesAppended` is omitted, events are opt-in if `onFramesAppended` is set.
   */
  streamEvents?: {
    framesAppended?: StreamEventSpec;
  };

  /**
   * Segmentation mode for this live audio buffer.
   * Default: `off`.
   */
  segmentation?: AudioSegmentationConfig;

  /** Optional JS callback for producer-agnostic append events. */
  onFramesAppended?: (event: LiveAudioBufferFramesAppendedEvent) => void;
  /** Optional JS callback for segment commit events. */
  onSegment?: (event: LiveAudioBufferSegmentEvent) => void;
  /** Optional JS callback for live-buffer errors. */
  onError?: (event: LiveAudioBufferErrorEvent) => void;
}

/** Options for starting mic capture into a live buffer. */
export interface StartMicToLiveOptions {
  /** Compatibility switch: force-enable/disable centralized append events for this live buffer. */
  emitToJs?: boolean;
}

/** Mode for creating an offline buffer from a live buffer. */
export type OfflineFromLiveMode = 'fullIfSpooled' | 'windowSnapshot';

/** Mode for transferring a live spool into a new offline buffer (ownership handover). */
export type OfflineTransferFromLiveMode = 'fullIfSpooled';

// ========== Error Codes ==========

export const PipelineAudioErrorCode = {
  BUFFER_NOT_FOUND: 'AUDIO_BUFFER_NOT_FOUND',
  BUFFER_KIND_MISMATCH: 'AUDIO_BUFFER_KIND_MISMATCH',
  INVALID_ARGUMENT: 'AUDIO_INVALID_ARGUMENT',
  INVALID_STATE: 'AUDIO_INVALID_STATE',
  FILE_NOT_FOUND: 'AUDIO_FILE_NOT_FOUND',
  FILE_READ_ERROR: 'AUDIO_FILE_READ_ERROR',
  FILE_WRITE_ERROR: 'AUDIO_FILE_WRITE_ERROR',
  BUFFER_EMPTY: 'AUDIO_BUFFER_EMPTY',
  SPOOL_NOT_AVAILABLE: 'AUDIO_SPOOL_NOT_AVAILABLE',
  CAPTURE_ERROR: 'AUDIO_CAPTURE_ERROR',
  ALREADY_FINALIZED: 'AUDIO_ALREADY_FINALIZED',
  CURSOR_LAG_EXCEEDED: 'AUDIO_CURSOR_LAG_EXCEEDED',
  TRANSFER_INVALID_STATE: 'TRANSFER_INVALID_STATE',
  TRANSFER_SPOOL_UNAVAILABLE: 'TRANSFER_SPOOL_UNAVAILABLE',
  TRANSFER_CURSORS_ACTIVE: 'TRANSFER_CURSORS_ACTIVE',
  BUFFER_INVALIDATED: 'BUFFER_INVALIDATED',
  INTERNAL_ERROR: 'AUDIO_INTERNAL_ERROR',
} as const;

export type PipelineAudioErrorCodeValue =
  (typeof PipelineAudioErrorCode)[keyof typeof PipelineAudioErrorCode];

// ========== Audio Decode Types ==========

/** Options for decoding an audio file into a pipeline buffer. */
export interface AudioDecodeOptions {
  /**
   * Target sample rate in Hz. If omitted or 0, keeps the source file's native sample rate.
   * When specified, FFmpeg SwrContext resamples during decode (no second pass).
   */
  targetSampleRateHz?: number;

  /**
   * Force mono downmix. Default: true.
   * When true and source is stereo/multi-channel, downmixed during decode.
   */
  forceMono?: boolean;

  /**
   * Cancel the decode operation. When aborted, already-decoded data is retained
   * (offline: promise rejects; live: buffer stays recording with partial data).
   */
  signal?: AbortSignal;

  /**
   * Progress callback. Fired periodically during decode.
   * `percent` is always provided (estimated from file size when container
   * does not declare duration).
   */
  onProgress?: (event: DecodeProgressEvent) => void;
}

/** Progress event emitted during audio file decode. */
export interface DecodeProgressEvent {
  /** Number of output frames decoded so far. */
  framesDecoded: number;
  /**
   * Estimated total output frames. Exact when container provides duration,
   * estimated from file size and bitrate otherwise.
   */
  totalFramesEstimate: number;
  /** Progress 0–100. Always provided (estimated when exact value unavailable). */
  percent: number;
  /** Source file's original sample rate (before resampling). */
  sourceSampleRate: number;
  /** Source file's original channel count (before downmix). */
  sourceChannels: number;
}

// ========== File Ingest Types (Live Buffer) ==========

/**
 * Handle for a running file ingest operation on a live buffer.
 * Returned by `ingestFileToLiveAudioBuffer`.
 */
export interface FileIngestHandle {
  /** Unique ingest operation id (native-generated). */
  readonly ingestId: string;

  /** The live buffer being ingested into. */
  readonly liveBufferId: string;

  /**
   * Promise that resolves when ingest completes (all chunks decoded and appended).
   * Rejects on decode error or cancellation.
   */
  readonly done: Promise<FileIngestResult>;

  /**
   * Cancel the ingest. Already-appended samples are retained.
   * Buffer stays in `recording` state. Equivalent to aborting the signal.
   */
  cancel(): void;

  /** Query ingest status. Non-blocking. */
  getStatus(): Promise<FileIngestStatus>;
}

/** Result returned when file ingest completes successfully. */
export interface FileIngestResult {
  /** Total frames appended to the live buffer from this ingest. */
  totalFramesIngested: number;
  /** Source file's original sample rate. */
  sourceSampleRate: number;
  /** Source file's original channel count. */
  sourceChannels: number;
  /** Whether the buffer was auto-finalized after ingest. */
  autoFinalized: boolean;
}

/** Status snapshot of a running file ingest operation. */
export interface FileIngestStatus {
  /** Whether the ingest is still running. */
  isRunning: boolean;
  /** Frames decoded and appended so far. */
  framesIngested: number;
  /** Estimated total frames (same semantics as DecodeProgressEvent). */
  totalFramesEstimate: number;
  /** Progress 0–100. */
  percent: number;
  /** Error message if ingest failed (undefined while running or on success). */
  error?: string;
}

/** Options for `ingestFileToLiveAudioBuffer`. */
export interface FileIngestOptions extends AudioDecodeOptions {
  /**
   * Automatically finalize the live buffer when file ingest completes.
   * Default: `false`.
   *
   * When false, the buffer stays in `recording` state after ingest,
   * allowing further appends (more files, mic, samples).
   * When true, the buffer transitions to `finished` after the last chunk.
   */
  autoFinalize?: boolean;

  /**
   * Producer backpressure mode.
   * - 'block' (default for file ingest): decoder waits until slowest cursor has room.
   * - 'none': decoder runs at full speed; spool holds all data.
   */
  backpressure?: AppendBackpressure;
}

// ========== Decode Error Codes ==========

/** Error codes for audio decode operations (DECODE_* family). */
export const DecodeErrorCode = {
  /** File not found or fd invalid. */
  NOT_FOUND: 'DECODE_NOT_FOUND',
  /** FFmpeg could not open/probe the input (unsupported or corrupted container). */
  OPEN_FAILED: 'DECODE_OPEN_FAILED',
  /** No audio stream found in container. */
  NO_AUDIO_STREAM: 'DECODE_NO_AUDIO_STREAM',
  /** Decoder initialization failed (unsupported codec). */
  CODEC_UNSUPPORTED: 'DECODE_CODEC_UNSUPPORTED',
  /** Error during decode loop (corrupted frames, read error). */
  DECODE_ERROR: 'DECODE_DECODE_ERROR',
  /** Resampling/downmix configuration failed. */
  RESAMPLE_ERROR: 'DECODE_RESAMPLE_ERROR',
  /** Operation cancelled via AbortSignal. */
  CANCELLED: 'DECODE_CANCELLED',
  /** Permission denied accessing the source. */
  PERMISSION_DENIED: 'DECODE_PERMISSION_DENIED',
  /** Generic internal decode error. */
  INTERNAL_ERROR: 'DECODE_INTERNAL_ERROR',
} as const;

export type DecodeErrorCodeValue =
  (typeof DecodeErrorCode)[keyof typeof DecodeErrorCode];
