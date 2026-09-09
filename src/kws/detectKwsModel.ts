import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import { ModelCategory } from '../download/types';
import type { QuantizationPreference } from '../download/types';
import type { FileSource } from '../fileio/types';
import {
  publicLanguageHintsFromNative,
  readPublicLanguageRows,
} from '../model-languages';
import {
  isDetectionSource,
  normalizeQuantization,
  type DetectionSource,
  type KwsDetectModelResult,
} from '../types/modelDetect';

export type KwsDetectOptions = {
  assetName?: string;
  modelType?: 'auto' | 'transducer';
  quantization?: QuantizationPreference;
};

export async function detectKwsModel(
  source: FileSource,
  options?: KwsDetectOptions
): Promise<KwsDetectModelResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectKwsModel(
    resolved.modelDir,
    assetName,
    options?.modelType ?? null,
    options?.quantization ?? null
  );
  const error = typeof raw.error === 'string' ? raw.error.trim() : '';
  const detectionSources: DetectionSource[] = [];
  for (const sourceValue of raw.detectionSources ?? []) {
    if (isDetectionSource(sourceValue)) detectionSources.push(sourceValue);
  }
  const languages = publicLanguageHintsFromNative({
    domain: ModelCategory.Kws,
    modelType: raw.modelType,
    rawRows: readPublicLanguageRows(raw.languages),
  });
  const paths = Object.fromEntries(
    Object.entries(raw.paths ?? {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim().length > 0
    )
  );
  return {
    success: raw.success,
    isStreaming: raw.isStreaming === true,
    ...(error ? { error } : {}),
    detectedModels: raw.detectedModels ?? [],
    ...(raw.modelType ? { modelType: raw.modelType } : {}),
    ...(languages.length > 0 ? { languages } : {}),
    ...(normalizeQuantization(raw.quantization)
      ? { quantization: normalizeQuantization(raw.quantization) }
      : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(Object.keys(paths).length > 0 ? { paths } : {}),
  };
}
