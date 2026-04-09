import type {
  SessionId,
  SegmentId,
  SessionEvent,
  SegmentEvent,
  IncrementalMetrics,
} from './types';
import type { TtsStreamChunk } from '../types';

// ---------------------------------------------------------------------------
// Session event factories
// ---------------------------------------------------------------------------

export function sessionStarted(sessionId: SessionId): SessionEvent {
  return { type: 'session:started', sessionId };
}

export function sessionIdle(sessionId: SessionId): SessionEvent {
  return { type: 'session:idle', sessionId };
}

export function sessionDraining(
  sessionId: SessionId,
  remainingSegments: number
): SessionEvent {
  return { type: 'session:draining', sessionId, remainingSegments };
}

export function sessionCancelled(
  sessionId: SessionId,
  droppedSegments: number
): SessionEvent {
  return { type: 'session:cancelled', sessionId, droppedSegments };
}

export function sessionError(
  sessionId: SessionId,
  error: string,
  segmentId?: SegmentId
): SessionEvent {
  return { type: 'session:error', sessionId, segmentId, error };
}

// ---------------------------------------------------------------------------
// Segment event factories
// ---------------------------------------------------------------------------

export function segmentQueued(
  sessionId: SessionId,
  segmentId: SegmentId,
  text: string,
  queuePosition: number
): SegmentEvent {
  return { type: 'segment:queued', sessionId, segmentId, text, queuePosition };
}

export function segmentStarted(
  sessionId: SessionId,
  segmentId: SegmentId
): SegmentEvent {
  return { type: 'segment:started', sessionId, segmentId };
}

export function segmentEnded(
  sessionId: SessionId,
  segmentId: SegmentId,
  cancelled: boolean
): SegmentEvent {
  return { type: 'segment:ended', sessionId, segmentId, cancelled };
}

export function segmentDropped(
  sessionId: SessionId,
  segmentId: SegmentId,
  reason: 'overflow' | 'cancelled' | 'replaced'
): SegmentEvent {
  return { type: 'segment:dropped', sessionId, segmentId, reason };
}

export function segmentChunk(
  sessionId: SessionId,
  segmentId: SegmentId,
  chunk: TtsStreamChunk
): SegmentEvent {
  return { type: 'segment:chunk', sessionId, segmentId, chunk };
}

// ---------------------------------------------------------------------------
// Metrics snapshot
// ---------------------------------------------------------------------------

export function metricsSnapshot(
  queueDepth: number,
  totalSegmentsQueued: number,
  totalSegmentsCompleted: number,
  totalSegmentsDropped: number,
  totalSegmentsReplaced: number,
  activeSegmentId: SegmentId | null
): IncrementalMetrics {
  return {
    queueDepth,
    totalSegmentsQueued,
    totalSegmentsCompleted,
    totalSegmentsDropped,
    totalSegmentsReplaced,
    activeSegmentId,
  };
}
