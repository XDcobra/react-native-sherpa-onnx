/**
 * Pipeline text buffer types for react-native-sherpa-onnx/textbuffer.
 *
 * Two core buffer kinds:
 * - OfflineTextBuffer: immutable, fully populated text (STT result, imported text)
 * - LiveTextBuffer: streaming, mutable text with recording/finished state machine
 *
 * Text buffers are pipeline building blocks: STT writes results into them,
 * future TTS will consume them as input.
 */

// ========== Buffer Kinds ==========

/** Pipeline text buffer discriminator (Info.kind). */
export type PipelineTextBufferKind = 'offlineTextBuffer' | 'liveTextBuffer';

// ========== Buffer States ==========

/** Offline text is immutable after population. */
export type OfflineTextBufferState = 'immutable';

/** Live text: recording → finished (no reverse). */
export type LiveTextBufferState = 'recording' | 'finished';

// ========== Info Types ==========

/** Metadata for an offline text buffer (after STT population or import). */
export interface OfflineTextBufferInfo {
  bufferId: string;
  kind: 'offlineTextBuffer';
  state: OfflineTextBufferState;
  /** UTF-16 length of the full hypothesis string. */
  utf16Length: number;
  tokenCount: number;
  timestampCount: number;
  durationCount: number;
  hasLang: boolean;
  hasEmotion: boolean;
  hasEvent: boolean;
}

/** Metadata for a live text buffer (streaming STT, incremental). */
export interface LiveTextBufferInfo {
  bufferId: string;
  kind: 'liveTextBuffer';
  state: LiveTextBufferState;
  /** Monotonic: accepted UTF-16 units (including rewrites if model replaces entirely). */
  totalCharsWritten: number;
  /** Generation/revision for partial events (native coalescing). */
  revision: number;
}

/** Discriminated union of all pipeline text buffer info types. */
export type PipelineTextBufferInfo = OfflineTextBufferInfo | LiveTextBufferInfo;

// ========== Branded Handle Types ==========

/**
 * Branded handle for an offline text buffer.
 * Compile-time guard: only offline text buffer IDs are accepted where this type is required.
 */
export type OfflineTextBufferHandle = string & {
  readonly __brand: 'OfflineTextBufferHandle';
};

/**
 * Branded handle for a live text buffer in recording state.
 */
export type LiveTextBufferHandleRecording = string & {
  readonly __brand: 'LiveTextBufferHandleRecording';
};

/**
 * Branded handle for a live text buffer in finished state.
 */
export type LiveTextBufferHandleFinished = string & {
  readonly __brand: 'LiveTextBufferHandleFinished';
};

/** Any live text buffer handle (recording or finished). */
export type LiveTextBufferHandle =
  | LiveTextBufferHandleRecording
  | LiveTextBufferHandleFinished;

/** Any pipeline text buffer handle. */
export type PipelineTextBufferHandle =
  | OfflineTextBufferHandle
  | LiveTextBufferHandle;

// ========== Ref Types (returned by create* functions) ==========

/**
 * Strongly-typed reference returned by offline text buffer creation functions.
 * Includes both metadata and branded handle.
 */
export interface OfflineTextBufferRef {
  info: OfflineTextBufferInfo;
  bufferId: OfflineTextBufferHandle;
}

/**
 * Strongly-typed reference returned by `createLiveTextBuffer` (recording state).
 * Includes metadata, branded recording handle, and event unsubscribe.
 */
export interface LiveTextBufferRef {
  info: LiveTextBufferInfo;
  bufferId: LiveTextBufferHandleRecording;
  unsubscribeEvents: () => void;
}

/** Argument that resolves to an offline text buffer native id. */
export type OfflineTextBufferIdSource =
  | OfflineTextBufferRef
  | OfflineTextBufferHandle
  | string;

/** Argument that resolves to a live text buffer native id (recording or finished). */
export type LiveTextBufferIdSource =
  | LiveTextBufferRef
  | LiveTextBufferHandleRecording
  | LiveTextBufferHandleFinished
  | string;

/** Argument for APIs that accept any pipeline text buffer (ref, last-fetched info, handle, or raw id). */
export type PipelineTextBufferIdSource =
  | OfflineTextBufferRef
  | LiveTextBufferRef
  | PipelineTextBufferInfo
  | OfflineTextBufferHandle
  | LiveTextBufferHandleRecording
  | LiveTextBufferHandleFinished
  | string;

/** Live text buffer in `recording` state (e.g. `finalizeLiveTextBuffer` input). */
export type LiveTextBufferRecordingSource =
  | LiveTextBufferRef
  | LiveTextBufferHandleRecording
  | string;

// ========== Live Callbacks ==========

/** Source of a partial update (native can aggregate). */
export type LiveTextBufferPartialSource =
  | 'stt_stream'
  | 'append'
  | 'replace'
  | 'unknown'
  | 'mixed';

/** Producer-agnostic event: new partial text was written to a live buffer. */
export interface LiveTextBufferPartialEvent {
  liveBufferId: string;
  source: LiveTextBufferPartialSource;
  /** Full partial hypothesis string for this event round. */
  partialText: string;
  revision: number;
  /** Present when online recognizer detects endpoint. */
  isEndpoint?: boolean;
}

/** Live text buffer error event. */
export interface LiveTextBufferErrorEvent {
  liveBufferId?: string;
  message: string;
}

/** Callback set for live text buffer partial/error events. */
export interface LiveTextBufferCallbacks {
  onPartial?: (event: LiveTextBufferPartialEvent) => void;
  onError?: (event: LiveTextBufferErrorEvent) => void;
}

// ========== Creation Options ==========

/** Options for `createLiveTextBuffer`. */
export interface CreateLiveTextBufferOptions {
  /** Max held UTF-16 characters for partial history (ring). Default: native/SDK. */
  windowMaxChars?: number;
  emitPartialEvents?: boolean;
  partialEventMinIntervalMs?: number;
  onPartial?: (event: LiveTextBufferPartialEvent) => void;
  onError?: (event: LiveTextBufferErrorEvent) => void;
}

/** Mode for creating an offline buffer from a live buffer. */
export type OfflineTextBufferFromLiveMode = 'fullIfSpooled' | 'windowSnapshot';

// ========== Error Codes ==========

export const PipelineTextErrorCode = {
  BUFFER_NOT_FOUND: 'TEXT_BUFFER_NOT_FOUND',
  BUFFER_KIND_MISMATCH: 'TEXT_BUFFER_KIND_MISMATCH',
  INVALID_ARGUMENT: 'TEXT_INVALID_ARGUMENT',
  INVALID_STATE: 'TEXT_INVALID_STATE',
  BUFFER_EMPTY: 'TEXT_BUFFER_EMPTY',
  ALREADY_FINALIZED: 'TEXT_ALREADY_FINALIZED',
  ALREADY_POPULATED: 'TEXT_ALREADY_POPULATED',
  SLICE_INVALID: 'TEXT_SLICE_INVALID',
  SLICE_TOO_LARGE: 'TEXT_SLICE_TOO_LARGE',
  INTERNAL_ERROR: 'TEXT_INTERNAL_ERROR',
} as const;

export type PipelineTextErrorCodeValue =
  (typeof PipelineTextErrorCode)[keyof typeof PipelineTextErrorCode];

// ========== Slice Constants ==========

export const TEXT_DEFAULT_SLICE_COUNT = 1024;
export const TEXT_MAX_SLICE_COUNT = 16384;
