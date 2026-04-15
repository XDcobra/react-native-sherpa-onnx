import SherpaOnnx from '../NativeSherpaOnnx';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';
import type { AlignmentModelType } from './types';
import {
  isDetectionSource,
  type DetectionSource,
  type DetectedModelEntry,
  type AlignmentDetectModelResult,
} from '../types/modelDetect';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';

export {
  alignTextToAudio,
  assertAlignmentGranularityForMode,
} from './alignTextToAudio';

export type {
  AlignTextToAudioFn,
  AlignTextToAudioOptions,
  AlignTextToAudioOptionsAccurate,
  AlignTextToAudioOptionsEstimated,
  AlignTextToAudioOptionsProportional,
  AlignTextToAudioResult,
  AlignmentChunkTimeline,
  AlignmentDetectResult,
  AlignmentGranularity,
  AlignmentModelType,
  AlignmentTimestamp,
  AlignmentTimingMode,
  SubtitleTimingItem,
} from './types';
export type { AlignmentDetectModelResult } from '../types/modelDetect';

export async function detectAlignmentModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: AlignmentModelType }
): Promise<AlignmentDetectModelResult> {
  const resolvedPath = await resolveModelPath(modelPath);
  const raw = await SherpaOnnx.detectAlignmentModel(
    resolvedPath,
    options?.modelType
  );
  const err = typeof raw.error === 'string' ? raw.error.trim() : '';
  const detectedModels: DetectedModelEntry[] = (raw.detectedModels ?? []).map(
    (m) => ({
      type: m.type,
      modelDir: m.modelDir,
    })
  );
  const detectionSources: DetectionSource[] = [];
  const rawSources = raw.detectionSources;
  if (Array.isArray(rawSources)) {
    for (const s of rawSources) {
      if (typeof s === 'string' && isDetectionSource(s)) {
        detectionSources.push(s);
      }
    }
  }
  const modelType =
    typeof raw.modelType === 'string' && raw.modelType !== ''
      ? raw.modelType
      : undefined;
  const rawLanguageStrings =
    Array.isArray(raw.languages) && raw.languages.length > 0
      ? raw.languages.filter((x): x is string => typeof x === 'string')
      : [];
  const resolvedLanguages = resolvePublicLanguageHints({
    domain: ModelCategory.Alignment,
    modelType,
    rawFromNative: rawLanguageStrings,
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const modelFilePath =
    typeof raw.paths?.model === 'string' ? raw.paths.model.trim() : '';
  return {
    success: raw.success,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(modelType != null ? { modelType } : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(modelFilePath.length > 0 ? { paths: { model: modelFilePath } } : {}),
  };
}
