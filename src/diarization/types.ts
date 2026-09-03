import type { DiarizationDetectModelResult } from '../types/modelDetect';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type DiarizationDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

export type DiarizationModelKind = 'pyannote' | 'reverb';

export const DIARIZATION_MODEL_KINDS: readonly DiarizationModelKind[] = [
  'pyannote',
  'reverb',
] as const;

export type DiarizationDetectResult = DiarizationDetectModelResult;
