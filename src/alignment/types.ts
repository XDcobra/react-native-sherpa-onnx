import type { ModelPathConfig } from '../types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { OfflineSegmentBufferIdSource } from '../segmentbuffer/types';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';

export interface AlignmentTimestamp {
  text: string;
  start: number;
  end: number;
}

export type AlignmentModelType = 'wav2vec2' | 'auto';

export type { AlignmentDetectModelResult as AlignmentDetectResult } from '../types/modelDetect';

/** Subtitle/timestamp granularity (character only with `accurate`). */
export type AlignmentGranularity = 'sentence' | 'word' | 'character';

/**
 * Engine-agnostic timeline for **estimated** mode: one sample count per text segment
 * after splitting `text` with `granularity` (`sentence` or `word`).
 */
export interface AlignmentChunkTimeline {
  sampleRate: number;
  segmentSampleCounts: readonly number[];
}

export interface AlignmentVadSegmentationConfig {
  source: 'vad';
  segmentBuffer: OfflineSegmentBufferIdSource;
  /** Minimum required speech anchors before constrained accurate execution starts. Default: 2 */
  minAnchors?: number;
}

export type AlignmentMappingStrategy = 'asr_mediated' | 'chunked_forced_ctc';

export interface AlignmentAsrConfig {
  hypothesisTextBuffer: OfflineTextBufferIdSource;
}

export type AlignmentAccurateSegmentationConfig =
  | {
      mode: 'off';
    }
  | {
      mode: 'auto';
      anchorSegmentBuffer: OfflineSegmentBufferIdSource;
      mappingStrategy: 'asr_mediated';
      asr: AlignmentAsrConfig;
    }
  | {
      mode: 'auto';
      anchorSegmentBuffer: OfflineSegmentBufferIdSource;
      mappingStrategy: 'chunked_forced_ctc';
      asr?: never;
    };

export type AlignmentTimingMode =
  | 'proportional'
  | 'estimated'
  | 'aligned'
  | 'accurate'
  | 'vad';

export interface AlignTextToAudioWriteResult {
  outputSegmentBufferId: string;
  segmentsWritten: number;
  warningCode?: string;
  vadAnchorCount?: number;
  minAnchorsApplied?: number;
}

/** Proportional: duration × text-weight only; no external chunks, no alignment model. */
export type AlignTextToAudioOptionsProportional = {
  mode: 'proportional';
  granularity?: 'sentence' | 'word';
  language?: string;
  segmentation?: never;
};

/** Estimated: segment sample counts from synthesis, STT, or other engines. */
export type AlignTextToAudioOptionsEstimated = {
  mode: 'estimated';
  chunks: AlignmentChunkTimeline;
  granularity?: 'sentence' | 'word';
  language?: string;
  segmentation?: never;
};

/** Accurate: wav2vec2 CTC forced alignment. */
export type AlignTextToAudioOptionsAccurate =
  | {
      mode: 'accurate';
      /** Same shape as STT/VAD `modelPath`; resolved before the native bridge. */
      modelPath: ModelPathConfig;
      granularity?: AlignmentGranularity;
      language?: string;
      segmentation?: {
        mode: 'off';
      };
    }
  | {
      mode: 'accurate';
      modelPath: ModelPathConfig;
      granularity?: 'sentence' | 'word';
      language?: string;
      segmentation: Extract<
        AlignmentAccurateSegmentationConfig,
        { mode: 'auto' }
      >;
    };

/** VAD standalone: segment-buffer anchored timing without CTC alignment model. */
export type AlignTextToAudioOptionsVad = {
  mode: 'vad';
  granularity?: 'sentence' | 'word';
  language?: string;
  segmentation: AlignmentVadSegmentationConfig;
};

export type AlignTextToAudioOptions =
  | AlignTextToAudioOptionsProportional
  | AlignTextToAudioOptionsEstimated
  | AlignTextToAudioOptionsAccurate
  | AlignTextToAudioOptionsVad;

export type AlignTextToAudioFn = (
  textIn: OfflineTextBufferIdSource,
  audioIn: OfflineAudioBufferIdSource,
  segmentOut: OfflineSegmentBufferIdSource,
  options: AlignTextToAudioOptions
) => Promise<AlignTextToAudioWriteResult>;

export type AlignmentErrorCode =
  | 'ALIGNMENT_OPTIONS_INVALID'
  | 'ALIGNMENT_MODEL_PATH_INVALID'
  | 'ALIGNMENT_GRANULARITY_INVALID'
  | 'ALIGNMENT_ASR_HYPOTHESIS_MISSING'
  | 'ALIGNMENT_NOT_IMPLEMENTED'
  | 'ALIGNMENT_ENGINE_DESTROYED';
