/**
 * Pipeline segment buffer types for react-native-sherpa-onnx/segmentbuffer.
 */

export type PipelineSegmentBufferKind =
  | 'offlineSegmentBuffer'
  | 'liveSegmentBuffer';

export type OfflineSegmentBufferState = 'immutable';
export type LiveSegmentBufferState = 'recording' | 'finished';

export type SegmentKind = 'speech';

export type SegmentBufferSpoolingMode = 'off' | 'auto' | 'on';

export interface SegmentBufferSpoolingOptions {
  mode?: SegmentBufferSpoolingMode;
  path?: string;
  temporary?: boolean;
  thresholdBytes?: number;
}

export interface LiveSegmentBufferSpoolInfo {
  mode: SegmentBufferSpoolingMode;
  enabled: boolean;
  ready: boolean;
  bytes: number;
  path?: string;
}

export interface SegmentMeta {
  id: string;
  kind: SegmentKind;
  sourceAudioBufferId: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
  durationMs: number;
  confidence?: number;
  payload?: Record<string, unknown>;
}

export interface SegmentInput {
  kind?: SegmentKind;
  sourceAudioBufferId: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
  durationMs?: number;
  confidence?: number;
  payload?: Record<string, unknown>;
}

export interface OfflineSegmentBufferInfo {
  bufferId: string;
  kind: 'offlineSegmentBuffer';
  state: OfflineSegmentBufferState;
  segmentCount: number;
  sourceAudioBufferId?: string;
}

export interface LiveSegmentBufferInfo {
  bufferId: string;
  kind: 'liveSegmentBuffer';
  state: LiveSegmentBufferState;
  segmentCount: number;
  totalSegmentsWritten: number;
  spool: LiveSegmentBufferSpoolInfo;
}

export type PipelineSegmentBufferInfo =
  | OfflineSegmentBufferInfo
  | LiveSegmentBufferInfo;

export type OfflineSegmentBufferHandle = string & {
  readonly __brand: 'OfflineSegmentBufferHandle';
};

export type LiveSegmentBufferHandleRecording = string & {
  readonly __brand: 'LiveSegmentBufferHandleRecording';
};

export type LiveSegmentBufferHandleFinished = string & {
  readonly __brand: 'LiveSegmentBufferHandleFinished';
};

export type LiveSegmentBufferHandle =
  | LiveSegmentBufferHandleRecording
  | LiveSegmentBufferHandleFinished;

export interface OfflineSegmentBufferRef {
  info: OfflineSegmentBufferInfo;
  bufferId: OfflineSegmentBufferHandle;
}

export interface LiveSegmentBufferRef {
  info: LiveSegmentBufferInfo;
  bufferId: LiveSegmentBufferHandleRecording;
}

export type OfflineSegmentBufferIdSource =
  | OfflineSegmentBufferRef
  | OfflineSegmentBufferHandle
  | string;

export type LiveSegmentBufferIdSource =
  | LiveSegmentBufferRef
  | LiveSegmentBufferHandleRecording
  | LiveSegmentBufferHandleFinished
  | string;

export type PipelineSegmentBufferIdSource =
  | OfflineSegmentBufferRef
  | LiveSegmentBufferRef
  | PipelineSegmentBufferInfo
  | OfflineSegmentBufferHandle
  | LiveSegmentBufferHandleRecording
  | LiveSegmentBufferHandleFinished
  | string;

export type LiveSegmentBufferRecordingSource =
  | LiveSegmentBufferRef
  | LiveSegmentBufferHandleRecording
  | string;

export type OfflineSegmentBufferFromLiveMode =
  | 'fullIfSpooled'
  | 'windowSnapshot';

export interface CreateLiveSegmentBufferOptions {
  sourceAudioBufferId?: string;
  maxSegments?: number;
  spooling?: SegmentBufferSpoolingOptions;
}

export interface CreateEmptyOfflineSegmentBufferOptions {
  sourceAudioBufferId?: string;
}

export const PipelineSegmentErrorCode = {
  BUFFER_NOT_FOUND: 'SEGMENT_BUFFER_NOT_FOUND',
  BUFFER_KIND_MISMATCH: 'SEGMENT_BUFFER_KIND_MISMATCH',
  INVALID_ARGUMENT: 'SEGMENT_INVALID_ARGUMENT',
  INVALID_STATE: 'SEGMENT_INVALID_STATE',
  ALREADY_FINALIZED: 'SEGMENT_ALREADY_FINALIZED',
  SLICE_INVALID: 'SEGMENT_SLICE_INVALID',
  SPOOL_UNAVAILABLE: 'SEGMENT_SPOOL_UNAVAILABLE',
  SPOOL_WRITE_FAILED: 'SEGMENT_SPOOL_WRITE_FAILED',
  SPOOL_READ_FAILED: 'SEGMENT_SPOOL_READ_FAILED',
  SPOOL_CORRUPTED: 'SEGMENT_SPOOL_CORRUPTED',
  INTERNAL_ERROR: 'SEGMENT_INTERNAL_ERROR',
} as const;

export type PipelineSegmentErrorCodeValue =
  (typeof PipelineSegmentErrorCode)[keyof typeof PipelineSegmentErrorCode];
