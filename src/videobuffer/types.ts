/**
 * Pipeline video buffer types for react-native-sherpa-onnx/videobuffer.
 *
 * OfflineVideoBuffer: immutable container + index.
 * LiveVideoBuffer: recording → finished (CAS, never back).
 */

export type PipelineVideoBufferKind = 'offlineVideoBuffer' | 'liveVideoBuffer';

export type OfflineVideoBufferState = 'immutable';
export type LiveVideoBufferState = 'recording' | 'finished';

export interface OfflineVideoBufferInfo {
  bufferId: string;
  kind: 'offlineVideoBuffer';
  state: 'immutable';
  frameCount: number;
  seekableStartUs?: number;
  seekableEndUs?: number;
}

export interface LiveVideoBufferInfo {
  bufferId: string;
  kind: 'liveVideoBuffer';
  state: LiveVideoBufferState;
  frameCount: number;
  totalFramesWritten: number;
  ringEvictedFrames: number;
  hasActiveSpool: boolean;
  liveEdgeUs?: number;
  seekableStartUs?: number;
  seekableEndUs?: number;
}

export type PipelineVideoBufferInfo =
  | OfflineVideoBufferInfo
  | LiveVideoBufferInfo;

export type OfflineVideoBufferHandle = string & {
  readonly __brand: 'OfflineVideoBufferHandle';
};

export type LiveVideoBufferHandleRecording = string & {
  readonly __brand: 'LiveVideoBufferHandleRecording';
};

export type LiveVideoBufferHandleFinished = string & {
  readonly __brand: 'LiveVideoBufferHandleFinished';
};

export type LiveVideoBufferHandle =
  | LiveVideoBufferHandleRecording
  | LiveVideoBufferHandleFinished;

export interface OfflineVideoBufferRef {
  info: OfflineVideoBufferInfo;
  bufferId: OfflineVideoBufferHandle;
}

export interface LiveVideoBufferRef {
  info: LiveVideoBufferInfo;
  bufferId: LiveVideoBufferHandleRecording;
  unsubscribeEvents: () => void;
}

export type LiveVideoBufferFinishedRef = {
  bufferId: LiveVideoBufferHandleFinished;
  info: LiveVideoBufferInfo;
};

export type OfflineVideoBufferIdSource =
  | OfflineVideoBufferRef
  | OfflineVideoBufferHandle
  | LiveVideoBufferFinishedRef
  | LiveVideoBufferHandleFinished
  | string;

export type LiveVideoBufferIdSource =
  | LiveVideoBufferRef
  | LiveVideoBufferHandleRecording
  | LiveVideoBufferHandleFinished
  | string;

export type PipelineVideoBufferIdSource =
  | OfflineVideoBufferRef
  | LiveVideoBufferRef
  | PipelineVideoBufferInfo
  | OfflineVideoBufferHandle
  | LiveVideoBufferHandle
  | string;

export type VideoRetention =
  | 'session'
  | 'none'
  | { mode: 'maxSeconds'; seconds: number }
  | { mode: 'path'; directory: string };

export interface CreateEmptyLiveVideoBufferOptions {
  ringSeconds?: number;
  retention?: VideoRetention;
}

export interface IngestFileToLiveOptions {
  pacing?: 'realtime' | 'asFast';
}

export interface CreateOfflineImageFromVideoOptions {
  sampling?: 'all' | 'keyframes' | 'fps' | 'uniform' | 'times';
  fps?: number;
  uniformCount?: number;
  timesUs?: number[];
  maxSide?: number;
}

export type LiveVideoBufferEventType =
  | 'packetsAppended'
  | 'gopCommitted'
  | 'spoolOverflow'
  | 'spoolError'
  | 'finished';

export interface LiveVideoBufferEvent {
  type: LiveVideoBufferEventType;
  liveBufferId: string;
  frameCount?: number;
  totalFramesWritten?: number;
  liveEdgeUs?: number;
}

export interface ExportVideoFrameOptions {
  format?: 'jpeg' | 'png' | 'webp';
  maxSide?: number;
  quality?: number;
}
