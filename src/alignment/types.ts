export interface AlignmentTimestamp {
  text: string;
  start: number;
  end: number;
}

/** Raw word/char output from native CTC forced alignment (`alignAccurateFromPath` / `alignAccurateFromFloat32`). */
export interface CtcAlignmentNativeResult {
  words: AlignmentTimestamp[];
  chars: AlignmentTimestamp[];
}

/** @deprecated Prefer {@link CtcAlignmentNativeResult}; kept as alias for existing exports. */
export type AlignmentResult = CtcAlignmentNativeResult;

export type AlignmentModelType = 'wav2vec2' | 'auto';

export interface AlignmentDetectResult {
  success: boolean;
  error?: string;
  detectedModels: Array<{ type: string; modelDir: string }>;
  modelType?: string;
  paths?: {
    model?: string;
  };
}

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
 *
 * Invariant: `segmentSampleCounts.length` should match the number of segments; the sum
 * should match the decoded mono PCM length (minor rounding differences are tolerated).
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

type AlignAudioInput = string | { samples: number[]; sampleRate: number };

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
