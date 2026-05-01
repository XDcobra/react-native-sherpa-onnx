import type { StreamEventSpec } from '../pipeline/streamEvents';
import type { PipelineAudioBufferIdSource } from '../audiobuffer/types';

/**
 * Pipeline segment buffer types for react-native-sherpa-onnx/segmentbuffer.
 */

export type PipelineSegmentBufferKind =
  | 'offlineSegmentBuffer'
  | 'liveSegmentBuffer';

export type OfflineSegmentBufferState = 'immutable';
export type LiveSegmentBufferState = 'recording' | 'finished';

export type SegmentKind = 'speech' | 'alignment';

export type AlignmentTimingMode =
  | 'proportional'
  | 'estimated'
  | 'accurate'
  | 'vad';

export type AlignmentGranularity = 'sentence' | 'word' | 'character';

export type SpeechSegmentPayloadSource = 'vad' | 'stt' | 'tts';

export interface VadSpeechSegmentPayload {
  source: 'vad';
  engine?: 'vad';
  decision?: 'model';
  score?: number;
}

export interface SttSpeechSegmentPayload {
  source: 'stt';
  transcript?: string;
  tokenCount?: number;
  isFinal?: boolean;
}

export interface TtsSpeechSegmentPayload {
  source: 'tts';
  text?: string;
  chunkIndex?: number;
  isFinalChunk?: boolean;
}

export type SpeechSegmentPayload =
  | VadSpeechSegmentPayload
  | SttSpeechSegmentPayload
  | TtsSpeechSegmentPayload;

export interface AlignmentSegmentPayload {
  [key: string]: unknown;
  text: string;
  timingMode: AlignmentTimingMode;
  granularity: AlignmentGranularity;
  confidence?: number;
  tokenMetadata?: Record<string, unknown>;
  wordMetadata?: Record<string, unknown>;
  languageHints?: string[];
}

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

interface SegmentMetaBase {
  id: string;
  sourceAudioBufferId: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
  durationMs: number;
  confidence?: number;
}

export interface SpeechSegmentMeta extends SegmentMetaBase {
  kind: 'speech';
  payload?: SpeechSegmentPayload;
}

export interface AlignmentSegmentMeta extends SegmentMetaBase {
  kind: 'alignment';
  payload?: AlignmentSegmentPayload;
}

interface SegmentInputBase {
  kind?: SegmentKind;
  sourceAudioBufferId: PipelineAudioBufferIdSource;
  startSample: number;
  endSample: number;
  sampleRate: number;
  durationMs?: number;
  confidence?: number;
}

export interface SpeechSegmentInput extends SegmentInputBase {
  kind?: 'speech';
  payload?: SpeechSegmentPayload;
}

export interface AlignmentSegmentInput extends SegmentInputBase {
  kind: 'alignment';
  payload: AlignmentSegmentPayload;
}

export type SegmentInput = SpeechSegmentInput | AlignmentSegmentInput;
export type SegmentMeta = SpeechSegmentMeta | AlignmentSegmentMeta;

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
  /** Unsubscribe from live segment buffer `onSegmentAppended` / `onError` listeners created with this ref. */
  unsubscribeEvents: () => void;
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

interface LiveSegmentBufferSegmentAppendedEventBase {
  liveBufferId: string;
  totalSegments: number;
  segmentId: string;
  segmentIndex: number;
  sourceAudioBufferId: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
  durationMs: number;
  confidence?: number;
}

/** Fired when a new segment is appended to a live segment buffer (native → JS; fat metadata). */
export interface LiveSpeechSegmentAppendedEvent
  extends LiveSegmentBufferSegmentAppendedEventBase {
  kind: 'speech';
  payload?: SpeechSegmentPayload;
}

/** Fired when a new segment is appended to a live segment buffer (native → JS; fat metadata). */
export interface LiveAlignmentSegmentAppendedEvent
  extends LiveSegmentBufferSegmentAppendedEventBase {
  kind: 'alignment';
  payload?: AlignmentSegmentPayload;
}

export type LiveSegmentBufferSegmentAppendedEvent =
  | LiveSpeechSegmentAppendedEvent
  | LiveAlignmentSegmentAppendedEvent;

/** Error tied to a live segment buffer (e.g. spool I/O in future paths). */
export interface LiveSegmentBufferErrorEvent {
  liveBufferId?: string;
  message: string;
}

export interface CreateLiveSegmentBufferOptions {
  sourceAudioBufferId?: PipelineAudioBufferIdSource;
  maxSegments?: number;
  spooling?: SegmentBufferSpoolingOptions;
  /**
   * When `streamEvents.segmentAppended` is omitted, events are opt-in if `onSegmentAppended` is set.
   */
  streamEvents?: {
    segmentAppended?: StreamEventSpec;
  };
  onSegmentAppended?: (event: LiveSegmentBufferSegmentAppendedEvent) => void;
  onError?: (event: LiveSegmentBufferErrorEvent) => void;
}

export interface CreateEmptyOfflineSegmentBufferOptions {
  sourceAudioBufferId?: PipelineAudioBufferIdSource;
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
