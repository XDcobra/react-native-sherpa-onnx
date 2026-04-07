import SherpaOnnx from '../NativeSherpaOnnx';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';
import type { AlignmentDetectResult, AlignmentModelType } from './types';

export {
  WAV2VEC2_BLANK_ID,
  WAV2VEC2_FRAME_DURATION_S,
  WAV2VEC2_VOCAB,
  WAV2VEC2_WORD_BOUNDARY_ID,
} from './vocab';

export {
  alignTextToAudio,
  assertAlignmentGranularityForMode,
} from './alignTextToAudio';

export {
  splitTextIntoSentences,
  splitTextIntoWords,
  buildSubtitlesFromChunks,
} from './textSegments';

export type {
  AlignTextToAudioOptions,
  AlignTextToAudioOptionsAccurate,
  AlignTextToAudioOptionsEstimated,
  AlignTextToAudioOptionsProportional,
  AlignTextToAudioResult,
  AlignmentChunkTimeline,
  AlignmentDetectResult,
  AlignmentGranularity,
  AlignmentModelType,
  AlignmentResult,
  AlignmentTimestamp,
  AlignmentTimingMode,
  CtcAlignmentNativeResult,
  SubtitleTimingItem,
} from './types';

export async function detectAlignmentModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: AlignmentModelType }
): Promise<AlignmentDetectResult> {
  const resolvedPath = await resolveModelPath(modelPath);
  const raw = await SherpaOnnx.detectAlignmentModel(
    resolvedPath,
    options?.modelType
  );
  const err = typeof raw.error === 'string' ? raw.error.trim() : '';
  const modelFilePath =
    typeof raw.paths?.model === 'string' ? raw.paths.model.trim() : '';
  return {
    success: raw.success,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels: raw.detectedModels ?? [],
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
    ...(modelFilePath.length > 0 ? { paths: { model: modelFilePath } } : {}),
  };
}
