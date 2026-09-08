import type { QuantizationPreference } from '../download/types';
import type { LanguageIdDetectModelResult } from '../types/modelDetect';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type LanguageIdDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

export type LanguageIdModelType = 'whisper';

export const LANGUAGE_ID_MODEL_TYPES: readonly LanguageIdModelType[] = [
  'whisper',
] as const;

export type LanguageIdConcreteModelType = LanguageIdModelType;

export type LanguageIdDetectResult = LanguageIdDetectModelResult;

export type LanguageIdDetectOptions = {
  modelType?: LanguageIdModelType | 'auto';
  assetName?: string;
  quantization?: QuantizationPreference;
};
