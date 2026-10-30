import type { ViewProps } from 'react-native';
import type { PipelineVideoBufferKind } from '../videobuffer/types';

export type VideoPreviewPlayerId = string & {
  readonly __brand: 'VideoPreviewPlayerId';
};

export type VideoPreviewAudioOption =
  | { source: 'track'; required?: boolean }
  | { source: 'none' };

export type VideoPreviewState =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'buffering'
  | 'ended'
  | 'error'
  | 'released';

export type VideoPreviewSeekMode = 'exact' | 'keyframe' | 'closestKeyframe';

export interface VideoPreviewSeekResult {
  status: 'completed' | 'clamped' | 'superseded';
  requestedMs: number;
  actualMs: number;
}

export type VideoPreviewAudioUnavailableEvent = {
  type: 'audioUnavailable';
  reason: 'absent' | 'unsupportedCodec' | 'decodeFailed' | 'outputFailed';
  code:
    | 'VIDEO_NO_AUDIO_TRACK'
    | 'VIDEO_AUDIO_CODEC_UNSUPPORTED'
    | 'VIDEO_AUDIO_DECODE_FAILED'
    | 'VIDEO_PREVIEW_AUDIO_OUTPUT_FAILED';
  message: string;
  codec: string | null;
  atMs: number;
  videoContinues: true;
};

export type VideoPreviewAudioStatus =
  | { status: 'playing'; codec: string; sampleRate: number; channels: number }
  | { status: 'muted'; codec: string; sampleRate: number; channels: number }
  | { status: 'off' }
  | {
      status: 'unavailable';
      reason: VideoPreviewAudioUnavailableEvent['reason'];
      code: VideoPreviewAudioUnavailableEvent['code'];
      codec: string | null;
    }
  | { status: 'interrupted'; reason: 'focusLoss' | 'sessionInterruption' };

export interface VideoPreviewSnapshot {
  playerId: VideoPreviewPlayerId;
  bufferId: string;
  bufferKind: PipelineVideoBufferKind;
  state: VideoPreviewState;
  positionMs: number;
  durationMs: number | null;
  seekableRange: { startMs: number; endMs: number };
  liveEdgeMs: number | null;
  atLiveEdge: boolean;
  playbackRate: 1;
  videoAttached: boolean;
  audio: VideoPreviewAudioStatus;
  stats: {
    framesRendered: number;
    framesDropped: number;
    audioUnderruns: number;
    avOffsetMs: number;
  };
}

export type VideoPreviewEvent =
  | {
      type: 'stateChanged';
      state: VideoPreviewState;
      previousState: VideoPreviewState;
    }
  | {
      type: 'progress';
      positionMs: number;
      seekableRange: { startMs: number; endMs: number };
      liveEdgeMs: number | null;
      nativeTimestampMs: number;
    }
  | { type: 'firstFrameRendered'; positionMs: number }
  | {
      type: 'seekCompleted';
      result: VideoPreviewSeekResult;
      mode: VideoPreviewSeekMode;
    }
  | {
      type: 'seekClamped';
      requestedMs: number;
      actualMs: number;
      reason: 'beforeStart' | 'afterLiveEdge';
    }
  | { type: 'positionEvicted'; previousMs: number; newMs: number }
  | { type: 'liveEdgeResync'; lagMs: number; newMs: number }
  | VideoPreviewAudioUnavailableEvent
  | { type: 'audioInterrupted'; reason: 'focusLoss' | 'sessionInterruption' }
  | { type: 'ended' }
  | { type: 'error'; code: VideoPreviewErrorCode; message: string };

export type VideoPreviewEventType = VideoPreviewEvent['type'];
export type VideoPreviewEventOf<T extends VideoPreviewEventType> = Extract<
  VideoPreviewEvent,
  { type: T }
>;

export const VideoPreviewErrorCode = {
  VIDEO_PREVIEW_NOT_FOUND: 'VIDEO_PREVIEW_NOT_FOUND',
  VIDEO_PREVIEW_RELEASED: 'VIDEO_PREVIEW_RELEASED',
  VIDEO_PREVIEW_INVALID_STATE: 'VIDEO_PREVIEW_INVALID_STATE',
  VIDEO_PREVIEW_INVALID_ARGUMENT: 'VIDEO_PREVIEW_INVALID_ARGUMENT',
  VIDEO_PREVIEW_DECODER_BUSY: 'VIDEO_PREVIEW_DECODER_BUSY',
  VIDEO_PREVIEW_RENDER_FAILED: 'VIDEO_PREVIEW_RENDER_FAILED',
  VIDEO_PREVIEW_AUDIO_UNSUPPORTED: 'VIDEO_PREVIEW_AUDIO_UNSUPPORTED',
  VIDEO_PREVIEW_AUDIO_OUTPUT_FAILED: 'VIDEO_PREVIEW_AUDIO_OUTPUT_FAILED',
  VIDEO_NO_AUDIO_TRACK: 'VIDEO_NO_AUDIO_TRACK',
  VIDEO_AUDIO_CODEC_UNSUPPORTED: 'VIDEO_AUDIO_CODEC_UNSUPPORTED',
  VIDEO_AUDIO_DECODE_FAILED: 'VIDEO_AUDIO_DECODE_FAILED',
} as const;

export type VideoPreviewErrorCode =
  (typeof VideoPreviewErrorCode)[keyof typeof VideoPreviewErrorCode];

export class VideoPreviewError extends Error {
  readonly code: VideoPreviewErrorCode;
  readonly cause?: unknown;
  constructor(code: VideoPreviewErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'VideoPreviewError';
    this.code = code;
    this.cause = cause;
  }
}

export interface VideoPreviewPlayerOptions {
  audio?: VideoPreviewAudioOption;
  startAtMs?: number;
  live?: {
    startAt?: 'liveEdge' | 'oldest';
    targetLatencyMs?: number;
    maxLatencyMs?: number;
  };
  volume?: number;
  muted?: boolean;
  loop?: boolean;
  pauseOnBackground?: boolean;
  progressIntervalMs?: number;
  onAudioUnavailable?: (event: VideoPreviewAudioUnavailableEvent) => void;
  onError?: (error: VideoPreviewError) => void;
}

export interface VideoPreviewPlayer {
  readonly playerId: VideoPreviewPlayerId;
  readonly bufferId: string;
  readonly initialSnapshot: VideoPreviewSnapshot;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(
    positionMs: number,
    options?: { mode?: VideoPreviewSeekMode }
  ): Promise<VideoPreviewSeekResult>;
  seekBy(
    deltaMs: number,
    options?: { mode?: VideoPreviewSeekMode }
  ): Promise<VideoPreviewSeekResult>;
  seekToLiveEdge(): Promise<VideoPreviewSeekResult>;
  stepFrame(direction: 1 | -1): Promise<VideoPreviewSeekResult>;
  setVolume(volume: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setLoop(loop: boolean): Promise<void>;
  getSnapshot(): Promise<VideoPreviewSnapshot>;
  addListener<T extends VideoPreviewEventType>(
    type: T,
    listener: (e: VideoPreviewEventOf<T>) => void
  ): () => void;
  release(): Promise<void>;
}

export interface VideoPreviewViewProps extends ViewProps {
  player: VideoPreviewPlayer | null;
  resizeMode?: 'contain' | 'cover' | 'stretch';
  androidViewType?: 'surfaceView' | 'textureView';
}
