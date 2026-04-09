import type {
  TtsGenerationOptions,
  TtsStreamOptions,
  TtsStreamChunk,
  TtsStreamHandlers,
  TtsStreamToFileOptions,
  TtsStreamToFileHandlers,
  TtsStreamFileEnd,
  TTSInitializeOptions,
  TTSModelInfo,
} from '../types';
import type { StreamingTtsEngine } from '../streamingTypes';
import type { PcmPlayer } from '../../pcm/types';
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

export interface SegmentChunkEvent {
  type: 'segment:chunk';
  sessionId: SessionId;
  segmentId: SegmentId;
  chunk: TtsStreamChunk;
}

export type SegmentEvent =
  | SegmentQueuedEvent
  | SegmentStartedEvent
  | SegmentEndedEvent
  | SegmentDroppedEvent
  | SegmentChunkEvent;

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
// Per-request handlers (extend streaming handlers with incremental events)
// ---------------------------------------------------------------------------

export interface IncrementalStreamHandlers extends TtsStreamHandlers {
  onSessionEvent?: (event: SessionEvent) => void;
  onSegmentEvent?: (event: SegmentEvent) => void;
  onMetrics?: (metrics: IncrementalMetrics) => void;
}

export interface IncrementalStreamToFileHandlers
  extends TtsStreamToFileHandlers {
  onSessionEvent?: (event: SessionEvent) => void;
  onSegmentEvent?: (event: SegmentEvent) => void;
  onMetrics?: (metrics: IncrementalMetrics) => void;
  /**
   * Called for each segment after it has been written to its own file.
   * Because each segment is written to a unique path, use this to collect
   * the per-segment file paths (e.g. for later concatenation).
   */
  onSegmentFileEnd?: (
    event: TtsStreamFileEnd & { segmentId: SegmentId }
  ) => void;
}

// ---------------------------------------------------------------------------
// Controllers (per-request, returned by generate* methods)
// ---------------------------------------------------------------------------

export interface IncrementalStreamController {
  /** Push incremental text. May trigger auto-segmentation. */
  pushText(text: string): void;
  /** Force-commit the current buffer as a segment. */
  commit(options?: CommitOptions): void;
  /** Commit remainder and wait until all segments are processed. */
  flush(options?: FlushOptions): Promise<void>;
  /** Cancel generation. */
  cancel(options?: CancelOptions): Promise<void>;
  /** Current metrics snapshot. */
  getMetrics(): IncrementalMetrics;
  /** Player proxy over active segment player. Only when playback: true. */
  readonly player: PcmPlayer | null;
  /** Current session state. */
  readonly state: SessionState;
}

export interface IncrementalStreamFileController {
  /** Push incremental text. May trigger auto-segmentation. */
  pushText(text: string): void;
  /** Force-commit the current buffer as a segment. */
  commit(options?: CommitOptions): void;
  /** Commit remainder and wait until all segments are processed. */
  flush(options?: FlushOptions): Promise<void>;
  /** Cancel generation. */
  cancel(options?: CancelOptions): Promise<void>;
  /** Current metrics snapshot. */
  getMetrics(): IncrementalMetrics;
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
   * Start an incremental streaming speech request with native playback.
   * Returns a controller for pushing text, committing, flushing, and cancelling.
   * Only one active request at a time.
   */
  generateIncrementalSpeechStream(
    options: TtsGenerationOptions | undefined,
    handlers: IncrementalStreamHandlers,
    streamOptions?: TtsStreamOptions,
    incrementalOptions?: IncrementalRequestOptions
  ): IncrementalStreamController;

  /**
   * Start an incremental streaming speech request writing to a file.
   * Returns a controller for pushing text, committing, flushing, and cancelling.
   * Only one active request at a time.
   */
  generateIncrementalSpeechStreamToFile(
    options: TtsGenerationOptions | undefined,
    fileOptions: TtsStreamToFileOptions,
    handlers: IncrementalStreamToFileHandlers,
    incrementalOptions?: IncrementalRequestOptions
  ): IncrementalStreamFileController;

  /** Model sample rate and number of speakers. */
  getModelInfo(): Promise<TTSModelInfo>;
  getSampleRate(): Promise<number>;
  getNumSpeakers(): Promise<number>;

  /** Release native TTS resources. Do not use the engine after this. */
  destroy(): Promise<void>;
}
