import type { FileSource } from '../fileio/types';
import type { QuantizationPreference } from '../download/types';
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

/**
 * Alignment model family (detect / custom-init).
 * Currently only char-CTC wav2vec2-family packs.
 */
export type AlignmentModelFamily = 'wav2vec2' | 'auto';

/** Concrete family for custom init (no `auto`). */
export type AlignmentConcreteModelFamily = 'wav2vec2';

/** @deprecated Use {@link AlignmentModelFamily}. */
export type AlignmentModelType = AlignmentModelFamily;

/** @deprecated Use {@link AlignmentConcreteModelFamily}. */
export type AlignmentConcreteModelType = AlignmentConcreteModelFamily;

export type AlignmentAccurateModelAuto = {
  initMode?: 'auto';
  modelSource: FileSource;
  quantization?: QuantizationPreference;
  provider?: string;
  numThreads?: number;
};

export type AlignmentAccurateModelCustom = {
  initMode: 'custom';
  modelType: AlignmentConcreteModelFamily;
  customConfig: import('./customConfig').AlignmentCustomConfig;
  provider?: string;
  numThreads?: number;
};

export type AlignmentAccurateModelConfig =
  | AlignmentAccurateModelAuto
  | AlignmentAccurateModelCustom;

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
  | 'ALIGNMENT_UNALIGNABLE_TEXT_SKIPPED'
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
  | ({
      mode: 'accurate';
      granularity?: AlignmentGranularity;
      language?: string;
      segmentation?: {
        mode: 'off';
      };
    } & AlignmentAccurateModelConfig)
  | ({
      mode: 'accurate';
      granularity?: 'sentence' | 'word';
      language?: string;
      segmentation: Extract<
        AlignmentAccurateSegmentationConfig,
        { mode: 'auto' }
      >;
    } & AlignmentAccurateModelConfig);

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

/**
 * `alignTextToAudio` overloads by `options.mode`. No catch-all union — hover
 * shows only the codes for the mode you call (same pattern as STT `transcribe`).
 */
export interface AlignTextToAudioFn {
  /**
   * Duration × text-weight. No model, no VAD.
   * @throws {Error} `ALIGNMENT_ENGINE_DESTROYED` — called after `destroy()`.
   * @throws {Error} `ALIGNMENT_OPTIONS_INVALID` — options are malformed.
   * @throws {Error} `ALIGNMENT_GRANULARITY_INVALID` — not `sentence` or `word`.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_NOT_FOUND` — text buffer is unknown.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_KIND_MISMATCH` — text buffer is not offline.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_EMPTY` — text buffer has no content.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_NOT_FOUND` — audio buffer is unknown.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_KIND_MISMATCH` — audio buffer is not offline.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_EMPTY` — audio buffer has no samples.
   * @throws {Error} `ALIGNMENT_ERROR` — native proportional align failed.
   * @throws {Error} `OFFLINE_OOM` — native ran out of memory.
   */
  (
    textIn: OfflineTextBufferIdSource,
    audioIn: OfflineAudioBufferIdSource,
    segmentOut: OfflineSegmentBufferIdSource,
    options: AlignTextToAudioOptionsProportional
  ): Promise<AlignTextToAudioWriteResult>;

  /**
   * Use caller-supplied chunk sample counts.
   * @throws {Error} `ALIGNMENT_ENGINE_DESTROYED` — called after `destroy()`.
   * @throws {Error} `ALIGNMENT_OPTIONS_INVALID` — `chunks` or options are malformed.
   * @throws {Error} `ALIGNMENT_GRANULARITY_INVALID` — not `sentence` or `word`.
   * @throws {Error} `ALIGNMENT_CHUNKS_MISSING` — native estimated path has no sample counts.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_NOT_FOUND` — text buffer is unknown.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_KIND_MISMATCH` — text buffer is not offline.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_EMPTY` — text buffer has no content.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_NOT_FOUND` — audio buffer is unknown.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_KIND_MISMATCH` — audio buffer is not offline.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_EMPTY` — audio buffer has no samples.
   * @throws {Error} `ALIGNMENT_ERROR` — native estimated align failed.
   * @throws {Error} `OFFLINE_OOM` — native ran out of memory.
   */
  (
    textIn: OfflineTextBufferIdSource,
    audioIn: OfflineAudioBufferIdSource,
    segmentOut: OfflineSegmentBufferIdSource,
    options: AlignTextToAudioOptionsEstimated
  ): Promise<AlignTextToAudioWriteResult>;

  /**
   * VAD-anchored timing, no CTC model.
   * @throws {Error} `ALIGNMENT_ENGINE_DESTROYED` — called after `destroy()`.
   * @throws {Error} `ALIGNMENT_OPTIONS_INVALID` — `segmentation` is missing or malformed.
   * @throws {Error} `ALIGNMENT_GRANULARITY_INVALID` — not `sentence` or `word`.
   * @throws {Error} `ALIGNMENT_ERROR` — VAD helper failed or segmentation is missing.
   * @throws {Error} `SEGMENTATION_POLICY_INVALID` — `segmentation.mode` is `manual`.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_NOT_FOUND` — text buffer is unknown.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_KIND_MISMATCH` — text buffer is not offline.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_EMPTY` — text buffer has no content.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_NOT_FOUND` — audio buffer is unknown.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_KIND_MISMATCH` — audio buffer is not offline.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_EMPTY` — audio buffer has no samples.
   * @throws {Error} `OFFLINE_OOM` — native ran out of memory.
   */
  (
    textIn: OfflineTextBufferIdSource,
    audioIn: OfflineAudioBufferIdSource,
    segmentOut: OfflineSegmentBufferIdSource,
    options: AlignTextToAudioOptionsVad
  ): Promise<AlignTextToAudioWriteResult>;

  /**
   * wav2vec2 CTC (`accurate`). Linker / forced-CTC / native only on this path.
   * @throws {Error} `ALIGNMENT_ENGINE_DESTROYED` — called after `destroy()`.
   * @throws {Error} `ALIGNMENT_OPTIONS_INVALID` — options or accurate segmentation are malformed.
   * @throws {Error} `ALIGNMENT_GRANULARITY_INVALID` — granularity is not valid for this accurate path.
   * @throws {Error} `ALIGNMENT_MODEL_PATH_INVALID` — custom paths or `modelSource` are invalid.
   * @throws {Error} `ALIGNMENT_MODEL_MISSING` — auto mode resolved an empty model directory.
   * @throws {Error} `ALIGNMENT_MODEL_LOAD_FAILED` — alignment model could not be loaded.
   * @throws {Error} `ALIGNMENT_ASR_HYPOTHESIS_MISSING` — `asr_mediated` has no hypothesis buffer.
   * @throws {Error} `ALIGNMENT_ASR_HYPOTHESIS_MISSING_TIMESTAMPS` — hypothesis has no timestamps.
   * @throws {Error} `SEGMENTATION_POLICY_INVALID` — `segmentation.mode` is `manual`.
   * @throws {Error} `ALIGNMENT_LINKER_INPUT_INVALID` — linker inputs are malformed.
   * @throws {Error} `ALIGNMENT_LINKER_FAILED` — linker could not produce a mapping.
   * @throws {Error} `ALIGNMENT_LINKER_NO_MAPPING` — linker produced no usable mapping.
   * @throws {Error} `ALIGNMENT_ANCHOR_OUT_OF_RANGE` — an alignment anchor is outside the audio.
   * @throws {Error} `ALIGNMENT_FORCED_CTC_STUCK` — forced CTC cursor made no progress.
   * @throws {Error} `ALIGNMENT_FORCED_CTC_FAILED` — native forced CTC failed.
   * @throws {Error} `ALIGNMENT_NATIVE_ACCURATE_FAILED` — native accurate align failed.
   * @throws {Error} `ALIGNMENT_NATIVE_UNKNOWN` — native returned an unknown alignment error.
   * @throws {Error} `ALIGNMENT_CONSTRAINED_ACCURATE_ERROR` — constrained accurate pass failed.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_NOT_FOUND` — text buffer is unknown.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_KIND_MISMATCH` — text buffer is not offline.
   * @throws {Error} `ALIGNMENT_TEXT_BUFFER_EMPTY` — text buffer has no content.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_NOT_FOUND` — audio buffer is unknown.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_KIND_MISMATCH` — audio buffer is not offline.
   * @throws {Error} `ALIGNMENT_AUDIO_BUFFER_EMPTY` — audio buffer has no samples.
   * @throws {Error} `OFFLINE_OOM` — native ran out of memory.
   */
  (
    textIn: OfflineTextBufferIdSource,
    audioIn: OfflineAudioBufferIdSource,
    segmentOut: OfflineSegmentBufferIdSource,
    options: AlignTextToAudioOptionsAccurate
  ): Promise<AlignTextToAudioWriteResult>;
}

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
  | 'ALIGNMENT_ENGINE_DESTROYED'
  | 'ALIGNMENT_INVALID_ARGUMENT';
