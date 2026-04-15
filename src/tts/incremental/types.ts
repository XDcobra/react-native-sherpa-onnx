import type { TTSInitializeOptions, TTSModelInfo } from '../types';
import type {
  StreamingTtsEngine,
  TtsPipelineHandle,
  TtsPipelineOptions,
} from '../streamingTypes';
import type { LiveAudioBufferIdSource } from '../../audiobuffer/types';
import type { ModelPathConfig } from '../../types';

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

export type SessionId = string;
export type SegmentId = string;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export type SessionState =
  | 'idle'
  | 'active'
  | 'draining'
  | 'cancelled'
  | 'errored'
  | 'destroyed';

// ---------------------------------------------------------------------------
// Segmentation policy
// ---------------------------------------------------------------------------

export interface SegmentationPolicy {
  /** Characters that trigger a segment boundary (e.g. '.!?'). */
  boundaryChars?: string;
  /** Maximum chars per segment before forced split. Default: 500 */
  maxCharsPerSegment?: number;
  /** Milliseconds to wait after last pushText before auto-committing. Default: 2000 */
  maxWaitMs?: number;
  /** Minimum chars before a boundary is accepted. Default: 20 */
  minCharsPerSegment?: number;
  /** Debounce interval (ms) for rapid pushText calls. Default: 100 */
  debounceMs?: number;
}

// ---------------------------------------------------------------------------
// Queue policy
// ---------------------------------------------------------------------------

export type QueueMode = 'fifo' | 'replace-tail' | 'latest-wins';
export type OverflowStrategy = 'drop-oldest' | 'drop-newest' | 'reject';

export interface QueuePolicy {
  /** Queue processing mode. Default: 'fifo' */
  mode?: QueueMode;
  /** Maximum queued segments. Default: 50 */
  maxSegments?: number;
  /** Maximum total buffered chars. Default: 10000 */
  maxBufferedChars?: number;
  /** Overflow strategy. Default: 'drop-oldest' */
  overflowStrategy?: OverflowStrategy;
}

// ---------------------------------------------------------------------------
// Session events
// ---------------------------------------------------------------------------

export interface SessionStartedEvent {
  type: 'session:started';
  sessionId: SessionId;
}

export interface SessionIdleEvent {
  type: 'session:idle';
  sessionId: SessionId;
}

export interface SessionDrainingEvent {
  type: 'session:draining';
  sessionId: SessionId;
  remainingSegments: number;
}

export interface SessionCancelledEvent {
  type: 'session:cancelled';
  sessionId: SessionId;
  droppedSegments: number;
}

export interface SessionErrorEvent {
  type: 'session:error';
  sessionId: SessionId;
  segmentId?: SegmentId;
  error: string;
}

export type SessionEvent =
  | SessionStartedEvent
  | SessionIdleEvent
  | SessionDrainingEvent
  | SessionCancelledEvent
  | SessionErrorEvent;

// ---------------------------------------------------------------------------
// Segment events
// ---------------------------------------------------------------------------

export interface SegmentQueuedEvent {
  type: 'segment:queued';
  sessionId: SessionId;
  segmentId: SegmentId;
  text: string;
  queuePosition: number;
}

export interface SegmentStartedEvent {
  type: 'segment:started';
  sessionId: SessionId;
  segmentId: SegmentId;
}

export interface SegmentEndedEvent {
  type: 'segment:ended';
  sessionId: SessionId;
  segmentId: SegmentId;
  cancelled: boolean;
}

export interface SegmentDroppedEvent {
  type: 'segment:dropped';
  sessionId: SessionId;
  segmentId: SegmentId;
  reason: 'overflow' | 'cancelled' | 'replaced';
}

export type SegmentEvent =
  | SegmentQueuedEvent
  | SegmentStartedEvent
  | SegmentEndedEvent
  | SegmentDroppedEvent;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface IncrementalMetrics {
  queueDepth: number;
  totalSegmentsQueued: number;
  totalSegmentsCompleted: number;
  totalSegmentsDropped: number;
  totalSegmentsReplaced: number;
  activeSegmentId: SegmentId | null;
}

// ---------------------------------------------------------------------------
// Commit / Flush / Cancel options
// ---------------------------------------------------------------------------

export interface CommitOptions {
  /** If true, bypass min-length threshold. */
  force?: boolean;
}

export type FlushOptions = Record<string, never>;

export type CancelScope = 'all' | 'active' | 'queued';

export interface CancelOptions {
  /** What to cancel. Default: 'all' */
  scope?: CancelScope;
}

// ---------------------------------------------------------------------------
// Per-request options (optional overrides for a single request)
// ---------------------------------------------------------------------------

export interface IncrementalRequestOptions {
  /** Override factory-level segmentation policy for this request. */
  segmentation?: SegmentationPolicy;
  /** Override factory-level queue policy for this request. */
  queue?: QueuePolicy;
}

// ---------------------------------------------------------------------------
// Per-request handlers (pipeline-based: no chunk events)
// ---------------------------------------------------------------------------

export interface IncrementalStreamHandlers {
  onSessionEvent?: (event: SessionEvent) => void;
  onSegmentEvent?: (event: SegmentEvent) => void;
  onMetrics?: (metrics: IncrementalMetrics) => void;
}

// ---------------------------------------------------------------------------
// Controller (per-session, returned by startSession)
// ---------------------------------------------------------------------------

export interface IncrementalStreamController {
  /**
   * Push incremental text. May trigger auto-segmentation.
   * Detected segments are committed to the internal LiveTextBuffer
   * via appendLiveTextSegment() — the TTS pipeline worker picks them up natively.
   */
  pushText(text: string, meta?: { sid?: number; speed?: number }): void;
  /** Force-commit the current buffer as a segment. */
  commit(options?: CommitOptions): void;
  /** Commit remainder, finalize the text buffer, and wait until pipeline completes. */
  flush(options?: FlushOptions): Promise<void>;
  /** Cancel: stop pipeline, discard queued segments. */
  cancel(options?: CancelOptions): Promise<void>;
  /** Current metrics snapshot. */
  getMetrics(): IncrementalMetrics;
  /** The underlying TTS pipeline handle (for getStatus(), etc.). */
  readonly pipeline: TtsPipelineHandle;
  /** The internal LiveTextBuffer used for segmented text input. */
  readonly textBuffer: { bufferId: string };
  /** Current session state. */
  readonly state: SessionState;
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export type IncrementalStreamingTtsSource =
  | { engine: StreamingTtsEngine }
  | { engineOptions: TTSInitializeOptions | ModelPathConfig };

export interface IncrementalStreamingTtsFactoryOptions {
  /** Existing streaming engine or options to create one. */
  source: IncrementalStreamingTtsSource;
  /** Default segmentation policy (can be overridden per request). */
  segmentation?: SegmentationPolicy;
  /** Default queue policy (can be overridden per request). */
  queue?: QueuePolicy;
}

// ---------------------------------------------------------------------------
// Engine interface (factory-level, mirrors StreamingTtsEngine pattern)
// ---------------------------------------------------------------------------

export interface IncrementalStreamingTtsEngine {
  readonly instanceId: string;

  /**
   * Start an incremental speech synthesis session.
   *
   * Internally creates a LiveTextBuffer, starts a TTS pipeline to the
   * given audioOut buffer, and returns a controller for pushing text incrementally.
   *
   * Text segmentation happens in JS (pushText → boundary detection → commitSegment).
   * Audio synthesis happens entirely in native (TTS pipeline worker → LiveAudioBuffer).
   * Zero bridge traffic for audio data.
   *
   * @param audioOut - Target live audio buffer for synthesized PCM
   * @param ttsOptions - Pipeline-level TTS options (sid, speed, voiceClone)
   * @param incrementalOptions - Segmentation and queue policies
   */
  startSession(
    audioOut: LiveAudioBufferIdSource,
    ttsOptions?: TtsPipelineOptions,
    incrementalOptions?: IncrementalRequestOptions
  ): Promise<IncrementalStreamController>;

  /** Model sample rate and number of speakers. */
  getModelInfo(): Promise<TTSModelInfo>;
  getSampleRate(): Promise<number>;
  getNumSpeakers(): Promise<number>;

  /** Release native TTS resources. Do not use the engine after this. */
  destroy(): Promise<void>;
}
