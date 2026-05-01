import type { ModelPathConfig } from '../fileio/types';

export type SegmentationEvaluator =
  | 'text_synthetic_auto'
  | 'text_punctuation_assisted'
  | 'speech_energy_silence'
  | 'speech_vad_model'
  | 'continuous_frames';

export interface SegmentationPolicy {
  evaluator: SegmentationEvaluator;
  maxLengthChars?: number;
  sentenceBoundary?: boolean;
  /**
   * When set (non-empty), replaces the built-in sentence-boundary delimiter set for
   * `text_synthetic_auto` and `text_punctuation_assisted`. Each entry is one delimiter
   * string (often one character; multi-character sequences such as `…` or `\r\n` are allowed).
   * Omit or leave unset to use SDK defaults (Latin/CJK/Arabic/Devanagari punctuation + newline).
   */
  sentenceBoundaryChars?: string[];
  languageHints?: string[];
  silenceThresholdMs?: number;
  energyThresholdDb?: number;
  minSegmentMs?: number;
  maxSegmentMs?: number;
  hangoverMs?: number;
  checkpointIntervalMs?: number;
  punctuationInstanceId?: string;
  /**
   * Required for `speech_vad_model` (same shape as STT/VAD `modelPath`).
   * Resolved to an absolute path before the native bridge.
   */
  modelPath?: ModelPathConfig;
  vadThreshold?: number;
  vadMinSpeechMs?: number;
  vadMinSilenceMs?: number;
}

export interface SegmentationConfig {
  policy?: SegmentationPolicy;
}

export interface SegmentationEngineRef {
  engineId: string;
}

export interface SegmentationEngineInfo {
  engineId: string;
  attachedBufferId: string;
  domain: 'text' | 'speech';
  policy: SegmentationPolicy;
  state: 'active' | 'detached';
  totalSegmentsCommitted: number;
  lastSegmentId?: string;
  segmentBufferId?: string;
}
