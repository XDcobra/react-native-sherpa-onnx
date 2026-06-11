/**
 * Source Separation feature module.
 *
 * `detectSeparationModel` is implemented; runtime (`initializeSeparation`, `separateSources`)
 * follows in a later milestone.
 */

import SherpaOnnx from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import {
  publicLanguageHintsFromNative,
  readPublicLanguageRows,
} from '../model-languages';
import { ModelCategory } from '../download/types';
import {
  isDetectionSource,
  type DetectedModelEntry,
  type DetectionSource,
} from '../types/modelDetect';
import type { SeparationDetectResult, SeparationModelType } from './types';

export type {
  SeparationDetectResult,
  SeparationModelType,
  SeparationDetectModelResult,
} from './types';
export { SEPARATION_MODEL_TYPES } from './types';

export {
  assertSeparationCustomConfig,
  resolveSeparationCustomConfigPaths,
  resolveSpleeterCustomConfigPaths,
  resolveUvrCustomConfigPaths,
  SeparationErrorCode,
  type SpleeterCustomConfig,
  type UvrCustomConfig,
  type SpleeterCustomPathKey,
  type UvrCustomPathKey,
} from './customConfig';

export interface SeparationInitializeOptions {
  modelSource: FileSource;
}

export interface SeparatedSource {
  sourceId: string;
  outputPath: string;
}

function readNonEmptyPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Detect source separation model layout (Spleeter vs UVR) without running inference.
 * Offline only — `isStreaming` is always `false`.
 */
export async function detectSeparationModel(
  source: FileSource,
  options?: {
    modelType?: SeparationModelType | 'auto';
    assetName?: string;
  }
): Promise<SeparationDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectSeparationModel(
    resolved.modelDir,
    assetName,
    options?.modelType ?? null
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
  const resolvedLanguages = publicLanguageHintsFromNative({
    domain: ModelCategory.Separation,
    modelType: raw.modelType,
    rawRows: readPublicLanguageRows(raw.languages),
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const vocals = readNonEmptyPath(raw.paths?.vocals);
  const accompaniment = readNonEmptyPath(raw.paths?.accompaniment);
  const model = readNonEmptyPath(raw.paths?.model);
  const paths =
    vocals != null || accompaniment != null || model != null
      ? {
          ...(vocals != null ? { vocals } : {}),
          ...(accompaniment != null ? { accompaniment } : {}),
          ...(model != null ? { model } : {}),
        }
      : undefined;
  return {
    success: raw.success,
    isStreaming: false,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(paths != null ? { paths } : {}),
  };
}

/** @throws Not yet implemented */
export async function initializeSeparation(
  _options: SeparationInitializeOptions
): Promise<void> {
  throw new Error(
    'Source Separation runtime is not yet implemented. Use detectSeparationModel to validate model layout.'
  );
}

/** @throws Not yet implemented */
export function separateSources(_filePath: string): Promise<SeparatedSource[]> {
  throw new Error(
    'Source Separation runtime is not yet implemented. Use detectSeparationModel to validate model layout.'
  );
}

/** @throws Not yet implemented */
export function unloadSeparation(): Promise<void> {
  throw new Error('Source Separation runtime is not yet implemented.');
}
