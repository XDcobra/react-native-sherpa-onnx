import type { SpeakerEmbeddingDetectModelResult } from '../types/modelDetect';

export {
  DETECTION_SOURCES,
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type SpeakerEmbeddingDetectModelResult,
  type ModelDetectResultBase,
} from '../types/modelDetect';

export type SpeakerEmbeddingModelType = 'wespeaker' | '3d-speaker' | 'nemo';

export const SPEAKER_EMBEDDING_MODEL_TYPES: readonly SpeakerEmbeddingModelType[] =
  ['wespeaker', '3d-speaker', 'nemo'] as const;

export type SpeakerEmbeddingDetectResult = SpeakerEmbeddingDetectModelResult;
