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
  /**
   * Static `levels` only: target STFT window count across the full file.
   * Native code sets `hopSize ≈ totalSamples / levelsMaxStftFrames` (default 1024).
   */
  levelsMaxStftFrames?: number;
  /**
   * File / live-spool decode only: resample to this rate (mono) before STFT.
   * `0` = keep source rate. e.g. `8000` cuts decode/resample cost for viz-only previews.
   * Does not apply to existing `off_*` offline buffers (already decoded).
   */
  analysisSampleRateHz?: number;
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
