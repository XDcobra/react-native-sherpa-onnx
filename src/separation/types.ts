import type { SeparationDetectModelResult } from '../types/modelDetect';

export type SeparationModelType = 'spleeter' | 'uvr';

export const SEPARATION_MODEL_TYPES: readonly SeparationModelType[] = [
  'spleeter',
  'uvr',
] as const;

export type SeparationDetectResult = SeparationDetectModelResult;

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type SeparationDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';
