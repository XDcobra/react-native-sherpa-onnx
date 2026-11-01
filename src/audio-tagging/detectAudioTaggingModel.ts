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
  type AudioTaggingDetectModelResult,
  type DetectionSource,
} from '../types/modelDetect';

export type AudioTaggingDetectOptions = {
  assetName?: string;
  modelType?: 'auto' | 'ced' | 'zipformer';
  quantization?: QuantizationPreference;
};

/**
 * Detect an audio-tagging model layout without loading the engine.
 * @throws {Error} `FILEIO_INVALID_ARGUMENT` — malformed `FileSource` or empty `auto.tryOrder`.
 * @throws {Error} `FILEIO_NOT_FOUND` — no matching path or URI exists.
 * @throws {Error} `FILEIO_UNSUPPORTED_ON_PLATFORM` — source kind is not valid on this OS.
 * @throws {Error} `FILEIO_RESOLVE_ERROR` — source could not be opened or resolved to a model path.
 * @throws {Error} `FILEIO_PATH_TRAVERSAL_BLOCKED` — `app`/`pad` path escaped the base dir whitelist.
 */
export async function detectAudioTaggingModel(
  source: FileSource,
  options?: AudioTaggingDetectOptions
): Promise<AudioTaggingDetectModelResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectAudioTaggingModel(
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
    domain: ModelCategory.AudioTagging,
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
    isStreaming: false,
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
