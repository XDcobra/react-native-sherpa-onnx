/**
 * Pipeline audio buffer types for react-native-sherpa-onnx/audiobuffer.
 *
 * Two core buffer kinds:
 * - OfflinePcmBuffer: immutable, fully populated PCM data (from file, samples, or live snapshot)
 * - LivePcmBuffer: streaming, mutable PCM with recording/finished state machine
 */

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
 * Strongly-typed reference returned by `createLiveAudioBuffer` (recording state).
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
  totalSamplesDropped: number;
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
  /** Present when native emitAppendedSamples=true. */
  samples?: number[];
}

/** Live-buffer related error event (for example mic capture failures). */
export interface LiveAudioBufferErrorEvent {
  liveBufferId?: string;
  message: string;
}

/** Callback set for live buffer append/error events. */
export interface LiveAudioBufferCallbacks {
  onFramesAppended?: (event: LiveAudioBufferFramesAppendedEvent) => void;
  onError?: (event: LiveAudioBufferErrorEvent) => void;
}

// ========== Creation Options ==========

/** Options for creating a live audio buffer. */
export interface CreateLiveAudioBufferOptions {
  /** Sample rate in Hz (e.g. 16000, 44100). */
  sampleRate: number;
  /** Number of channels. Only 1 (mono) is supported. */
  channelCount?: number;
  /** Ring buffer window size in seconds. Default: 60. */
  windowSeconds?: number;
  /** Optional path for WAV spool file (persistence). */
  persistencePath?: string;
  /** Spool WAV format: "wav_pcm_s16le" (default) or "wav_pcm_float". */
  persistenceFormat?: 'wav_pcm_s16le' | 'wav_pcm_float';

  /** If true, emit producer-agnostic append events for this live buffer. */
  emitAppendedEvents?: boolean;
  /** If true, append events include Float32 samples. Default: true. */
  emitAppendedSamples?: boolean;
  /** Optional native event throttle/coalesce interval in ms. Default: 0 (no throttle). */
  appendEventMinIntervalMs?: number;

  /** Optional JS callback for producer-agnostic append events. */
  onFramesAppended?: (event: LiveAudioBufferFramesAppendedEvent) => void;
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
  INTERNAL_ERROR: 'AUDIO_INTERNAL_ERROR',
} as const;

export type PipelineAudioErrorCodeValue =
  (typeof PipelineAudioErrorCode)[keyof typeof PipelineAudioErrorCode];
