/**
 * Pipeline video buffer types for react-native-sherpa-onnx/videobuffer.
 *
 * OfflineVideoBuffer: immutable container + index.
 * LiveVideoBuffer: recording → finished (CAS, never back).
 */

export type PipelineVideoBufferKind = 'offlineVideoBuffer' | 'liveVideoBuffer';

export type OfflineVideoBufferState = 'immutable';
export type LiveVideoBufferState = 'recording' | 'finished';

export interface VideoAudioTrackInfo {
  codec: string;
  decodable: boolean;
  sampleRate: number;
  channels: number;
  startMs: number;
  durationMs: number;
}

export interface OfflineVideoBufferInfo {
  bufferId: string;
  kind: 'offlineVideoBuffer';
  state: 'immutable';
  frameCount: number;
  seekableStartUs?: number;
  seekableEndUs?: number;
  audio: VideoAudioTrackInfo | null;
  decoder?: import('../codec/types').CodecDecision;
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
  audio: VideoAudioTrackInfo | null;
  decoder?: import('../codec/types').CodecDecision;
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
  decodePolicy?: import('../codec/types').CodecPolicy;
}

export interface IngestFileToLiveOptions {
  pacing?: 'realtime' | 'asFast';
  includeAudio?: boolean;
}

export interface CreateOfflineVideoBufferFromFileOptions {
  decodePolicy?: import('../codec/types').CodecPolicy;
}

export interface CreateOfflineImageFromVideoOptions {
  sampling?: 'all' | 'keyframes' | 'fps' | 'uniform' | 'times';
  fps?: number;
  uniformCount?: number;
  timesUs?: number[];
  maxSide?: number;
  decodePolicy?: import('../codec/types').CodecPolicy;
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

export type VideoExportContainer = 'mp4' | 'mov' | 'mkv' | 'webm';
export type VideoExportCodec = 'h264' | 'hevc';

export interface ExportVideoOptions {
  codec?: VideoExportCodec;
  bitrate?: number;
  fromUs?: number;
  toUs?: number;
  maxSide?: number;
  decodePolicy?: import('../codec/types').CodecPolicy;
  encodePolicy?: import('../codec/types').CodecPolicy;
  onProgress?: (e: { percent: number; encodedUs: number }) => void;
  signal?: AbortSignal;
}

export interface ConfigureVideoBufferOptions {
  /** @deprecated Use configureCodecs({ budgets }) from react-native-sherpa-onnx/codec. */
}

export type VideoFileDurationProbe = {
  durationUs: number;
  isExact: boolean;
};

export type VideoFileContainerProbe = {
  inputFormatName: string;
  codecName: string;
  codedWidth: number;
  codedHeight: number;
  audioCodecName?: string;
};

export interface CreateOfflineAudioFromVideoOptions {
  targetSampleRateHz?: number;
  rangeMs?: { startMs: number; endMs: number };
  onProgress?: (e: { percent: number; decodedMs: number }) => void;
  signal?: AbortSignal;
}

export interface VideoAudioExtractResult {
  audio: import('../audiobuffer/types').OfflineAudioBufferRef;
  mediaStartMs: number;
  sourceCodec: string;
  sourceSampleRate: number;
  sourceChannels: number;
}
