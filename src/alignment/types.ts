import type { FileSource } from '../fileio/types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';
import type { OfflineSegmentBufferIdSource } from '../segmentbuffer/types';
import type { SegmentLinkMapRef } from '../segment/segment-link';
import type { OfflineTextBufferIdSource } from '../textbuffer/types';
import type { OrchestrationProgress } from '../pipeline/offlineOrchestrator';

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
      mode: 'manual';
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

export type AlignmentProgressCallbacks = {
  /**
   * Fires at the start of a coarse progress step.
   *
   * This callback follows offline orchestrator semantics and is not sample-accurate.
   * Alignment warnings remain the source for quality diagnostics.
   */
  onProgress?: (progress: OrchestrationProgress) => void;
};

export interface AlignTextToAudioWriteResult {
  outputSegmentBufferId: string;
  segmentsWritten: number;
  linkMap?: SegmentLinkMapRef;
  warningCode?: string;
  warnings?: AlignmentWarning[];
  vadAnchorCount?: number;
  minAnchorsApplied?: number;
}

export type AlignmentWarningCode =
  | 'ALIGNMENT_PARTIAL_COVERAGE'
  | 'ALIGNMENT_LOW_CONFIDENCE_UNIT_PRESENT'
  | 'ALIGNMENT_ANCHOR_NO_PROGRESS'
  | 'ALIGNMENT_RESIDUAL_TOKENS_REMAINING';

export interface AlignmentWarning {
  code: AlignmentWarningCode;
  message: string;
}

/** Proportional: duration × text-weight only; no external chunks, no alignment model. */
export type AlignTextToAudioOptionsProportional = {
  mode: 'proportional';
  granularity?: 'sentence' | 'word';
  language?: string;
  segmentation?: never;
} & AlignmentProgressCallbacks;

/** Estimated: segment sample counts from synthesis, STT, or other engines. */
export type AlignTextToAudioOptionsEstimated = {
  mode: 'estimated';
  chunks: AlignmentChunkTimeline;
  granularity?: 'sentence' | 'word';
  language?: string;
  segmentation?: never;
} & AlignmentProgressCallbacks;

type AlignTextToAudioOptionsAccurateBase =
  | {
      mode: 'accurate';
      /** FileSource for the alignment model; resolved before the native bridge. */
      modelSource: FileSource;
      granularity?: AlignmentGranularity;
      language?: string;
      segmentation?: {
        mode: 'off';
      };
    }
  | {
      mode: 'accurate';
      modelSource: FileSource;
      granularity?: 'sentence' | 'word';
      language?: string;
      segmentation: Extract<
        AlignmentAccurateSegmentationConfig,
        { mode: 'auto' }
      >;
    };

/** Accurate: wav2vec2 CTC forced alignment. */
export type AlignTextToAudioOptionsAccurate =
  AlignTextToAudioOptionsAccurateBase & AlignmentProgressCallbacks;

/** VAD standalone: segment-buffer anchored timing without CTC alignment model. */
export type AlignTextToAudioOptionsVad = {
  mode: 'vad';
  granularity?: 'sentence' | 'word';
  language?: string;
  segmentation: AlignmentVadSegmentationConfig;
} & AlignmentProgressCallbacks;

export type AlignTextToAudioOptions =
  | AlignTextToAudioOptionsProportional
  | AlignTextToAudioOptionsEstimated
  | AlignTextToAudioOptionsAccurate
  | AlignTextToAudioOptionsVad;

export type { OrchestrationProgress };

export type AlignTextToAudioFn = (
  textIn: OfflineTextBufferIdSource,
  audioIn: OfflineAudioBufferIdSource,
  segmentOut: OfflineSegmentBufferIdSource,
  options: AlignTextToAudioOptions
) => Promise<AlignTextToAudioWriteResult>;

export type AlignmentErrorCode =
  | 'OFFLINE_OOM'
  | 'ALIGNMENT_OPTIONS_INVALID'
  | 'ALIGNMENT_MODEL_PATH_INVALID'
  | 'ALIGNMENT_MODEL_LOAD_FAILED'
  | 'ALIGNMENT_GRANULARITY_INVALID'
  | 'ALIGNMENT_ASR_HYPOTHESIS_MISSING'
  | 'ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS'
  | 'ALIGNMENT_LINKER_INPUT_INVALID'
  | 'ALIGNMENT_LINKER_NO_MAPPING'
  | 'ALIGNMENT_LINKER_FAILED'
  | 'ALIGNMENT_ANCHOR_OUT_OF_RANGE'
  | 'ALIGNMENT_NATIVE_ACCURATE_FAILED'
  | 'ALIGNMENT_NATIVE_UNKNOWN'
  | 'ALIGNMENT_FORCED_CTC_FAILED'
  | 'ALIGNMENT_FORCED_CTC_STUCK'
  | 'ALIGNMENT_NOT_IMPLEMENTED'
  | 'ALIGNMENT_ENGINE_DESTROYED';
