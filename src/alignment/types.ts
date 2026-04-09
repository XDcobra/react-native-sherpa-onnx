export interface AlignmentTimestamp {
  text: string;
  start: number;
  end: number;
}

export type AlignmentModelType = 'wav2vec2' | 'auto';

export type { AlignmentDetectModelResult as AlignmentDetectResult } from '../types/modelDetect';

/** One subtitle cue with times in seconds. */
export interface SubtitleTimingItem {
  text: string;
  start: number;
  end: number;
}

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

export interface AlignTextToAudioResult {
  subtitles: SubtitleTimingItem[];
  timingMode: AlignmentTimingMode;
}

/** Standalone audio input for alignment. */
export type AlignAudioInput =
  | string
  | {
      samples: Float32Array;
      sampleRate: number;
    };

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
  text: string,
  audio: AlignAudioInput,
  options: AlignTextToAudioOptions
) => Promise<AlignTextToAudioResult>;

/** Public TTS sink input type for alignment convenience. */
export type AlignTextToTtsSinkInput = import('../tts/types').GeneratedAudio;

export type AlignTextToTtsSinkFn = (
  text: string,
  generatedAudio: AlignTextToTtsSinkInput,
  options: AlignTextToAudioOptions
) => Promise<AlignTextToAudioResult>;
