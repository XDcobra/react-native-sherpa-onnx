import type {
  LiveBufferHandleFinished,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import type { FileSource } from '../fileio/types';

export type AudioVisualizationKind = 'spectrum_bars';

export type AudioVisualizationTimeAggregate = 'max_hold' | 'mean';

export type AudioVisualizationOptions = {
  kind?: AudioVisualizationKind;
  barCount?: number;
  minHz?: number;
  maxHz?: number;
  timeAggregate?: AudioVisualizationTimeAggregate;
  includeTimeline?: boolean;
  frameCount?: number;
  frameDurationMs?: number;
  maxAnalysisDurationMs?: number;
};

export type AudioVisualizationProfile = {
  kind: AudioVisualizationKind;
  sampleRate: number;
  durationMs: number;
  barCount: number;
  levels: number[];
  frameCount: number;
  frameDurationMs: number;
  frames?: Float32Array;
};

export type AudioVisualizationInput =
  | FileSource
  | OfflineAudioBufferIdSource
  | LiveBufferHandleFinished
  | {
      kind: 'file';
      source: FileSource;
    }
  | {
      kind: 'offline';
      buffer: OfflineAudioBufferIdSource;
    }
  | {
      kind: 'live';
      handle: LiveBufferHandleFinished;
    };
