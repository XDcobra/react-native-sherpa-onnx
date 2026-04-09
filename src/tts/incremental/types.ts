import type {
  TtsGenerationOptions,
  TtsStreamOptions,
  TtsStreamChunk,
  TTSInitializeOptions,
} from '../types';
import type { StreamingTtsEngine } from '../streamingTypes';
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
// Factory options
// ---------------------------------------------------------------------------

export type IncrementalStreamingTtsSource =
  | { engine: StreamingTtsEngine }
  | { engineOptions: TTSInitializeOptions | ModelPathConfig };

export interface IncrementalStreamingTtsOptions {
  /** Existing streaming engine or options to create one. */
  source: IncrementalStreamingTtsSource;
  /** Segmentation policy for auto-detecting boundaries. */
  segmentation?: SegmentationPolicy;
  /** Queue policy for segment flow control. */
  queue?: QueuePolicy;
  /** Stream options forwarded per segment (defaults to playback:false, emitChunks:true). */
  streamOptions?: TtsStreamOptions;
  /** Generation options forwarded per segment. */
  generationOptions?: TtsGenerationOptions;
  /** Session-level event handler. */
  onSessionEvent?: (event: SessionEvent) => void;
  /** Segment-level event handler. */
  onSegmentEvent?: (event: SegmentEvent) => void;
  /** Metrics callback, fired on queue depth changes. */
  onMetrics?: (metrics: IncrementalMetrics) => void;
}

// ---------------------------------------------------------------------------
// Engine interface
// ---------------------------------------------------------------------------

export interface IncrementalStreamingTtsEngine {
  readonly sessionId: SessionId;
  readonly state: SessionState;

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

  /** Destroy engine and release resources. */
  destroy(): Promise<void>;
}
