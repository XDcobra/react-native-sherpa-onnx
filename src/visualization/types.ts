import type {
  LiveBufferHandleFinished,
  OfflineAudioBufferIdSource,
} from '../audiobuffer/types';
import type {
  FileDestination,
  FileSource,
  ResolvedFileRef,
} from '../fileio/types';

export type AudioVisualizationKind = 'spectrum_bars';

/** Magic "SVIZ" + versioned payload next to audio. */
export type AudioVisualizationProfileFormat = 'sherpa_viz_v1';

/** Shared persist knobs (destination is required whenever this object appears). */
export type PersistAudioVisualizationProfile = {
  destination: FileDestination;
  /** Default `sherpa_viz_v1`. */
  format?: AudioVisualizationProfileFormat;
  /**
   * When false, omit timeline `frames` even if present (smaller sidecar).
   * Default: true iff `profile.frames` is non-empty.
   */
  includeFrames?: boolean;
  /** Default false (fail if file exists). */
  overwrite?: boolean;
};

export type LoadAudioVisualizationProfileOptions = {
  /** Reject unsupported magic/version/kind. Default true. */
  strict?: boolean;
};

export type SavedAudioVisualizationRef = {
  format: AudioVisualizationProfileFormat;
  output: ResolvedFileRef;
  kind: AudioVisualizationKind;
  barCount: number;
  durationMs: number;
  sampleRate: number;
  hasFrames: boolean;
};

export type LoadAudioVisualizationProfileSource =
  | FileSource
  | { kind: 'file'; source: FileSource };

export type AudioVisualizationTimeAggregate = 'max_hold' | 'mean';

/** Decode (file/spool ingest) vs STFT spectrum analysis. */
export type VisualizationProgressPhase = 'decode' | 'analysis';

export type VisualizationProgressEvent = {
  phase: VisualizationProgressPhase;
  /** Progress within the current phase, 0..1. */
  phasePercent: number;
  /** Set during `decode` (PCM frames decoded). */
  framesDecoded?: number;
  totalFramesEstimate?: number;
  /** Set during `analysis` (STFT windows processed). */
  stftWindowsDone?: number;
  stftWindowsTotal?: number;
};

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
  /**
   * Optional progress for long-running visualization.
   * `decode` = container decode/resample; `analysis` = STFT / bar aggregation.
   * For `kind: 'file'`, both phases may advance while chunks are streamed.
   */
  onProgress?: (event: VisualizationProgressEvent) => void;
};

/** Compute options: either plain analysis, or analysis + required persist. */
export type ComputeAudioVisualizationProfileOptions =
  | AudioVisualizationOptions
  | (AudioVisualizationOptions & {
      /** If present, profile is also written; `destination` is required on this object. */
      persist: PersistAudioVisualizationProfile;
    });

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
