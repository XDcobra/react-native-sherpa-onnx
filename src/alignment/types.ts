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

export type AlignmentTimingMode = 'proportional' | 'estimated' | 'aligned';

export interface AlignTextToAudioWriteResult {
  outputSegmentBufferId: string;
  segmentsWritten: number;
}

/** Proportional: duration × text-weight only; no external chunks, no alignment model. */
export type AlignTextToAudioOptionsProportional = {
  mode: 'proportional';
  granularity?: 'sentence' | 'word';
  language?: string;
};

/** Estimated: segment sample counts from synthesis, STT, or other engines. */
export type AlignTextToAudioOptionsEstimated = {
  mode: 'estimated';
  chunks: AlignmentChunkTimeline;
  granularity?: 'sentence' | 'word';
  language?: string;
};

/** Accurate: wav2vec2 CTC forced alignment. */
export type AlignTextToAudioOptionsAccurate = {
  mode: 'accurate';
  alignmentModelPath: string;
  granularity?: AlignmentGranularity;
  language?: string;
};

export type AlignTextToAudioOptions =
  | AlignTextToAudioOptionsProportional
  | AlignTextToAudioOptionsEstimated
  | AlignTextToAudioOptionsAccurate;

export type AlignTextToAudioFn = (
  textIn: OfflineTextBufferIdSource,
  audioIn: OfflineAudioBufferIdSource,
  segmentOut: OfflineSegmentBufferIdSource,
  options: AlignTextToAudioOptions
) => Promise<AlignTextToAudioWriteResult>;
