import type { ModelPathConfig } from '../types';

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
