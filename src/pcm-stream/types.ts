/**
 * Pipeline audio buffer types for react-native-sherpa-onnx/pcm-stream.
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
}

/** Options for starting mic capture into a live buffer. */
export interface StartMicToLiveOptions {
  /** If true, also emit audio chunks to JS via pipelineLiveAudioChunk events. Default: false. */
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
