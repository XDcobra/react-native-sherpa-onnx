import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import {
  publicLanguageHintsFromNative,
  readPublicLanguageRows,
} from '../model-languages';
import { ModelCategory } from '../download/types';
import { normalizeQuantization } from '../types/modelDetect';
import type { FileSource } from '../fileio/types';
import { isDetectionSource } from './types';
import type {
  DetectedModelEntry,
  DetectionSource,
  LanguageIdDetectOptions,
  LanguageIdDetectResult,
} from './types';

export async function detectLanguageIdModel(
  source: FileSource,
  options?: LanguageIdDetectOptions
): Promise<LanguageIdDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectLanguageIdModel(
    resolved.modelDir,
    assetName,
    options?.modelType ?? null,
    options?.quantization ?? null
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
    domain: ModelCategory.LanguageId,
    modelType: raw.modelType,
    rawRows: readPublicLanguageRows(raw.languages),
  });
  const quantization = normalizeQuantization(raw.quantization);
  const encoderFilePath =
    typeof raw.paths?.encoder === 'string' ? raw.paths.encoder.trim() : '';
  const decoderFilePath =
    typeof raw.paths?.decoder === 'string' ? raw.paths.decoder.trim() : '';
  const paths: { encoder?: string; decoder?: string } = {};
  if (encoderFilePath.length > 0) {
    paths.encoder = encoderFilePath;
  }
  if (decoderFilePath.length > 0) {
    paths.decoder = decoderFilePath;
  }
  const hasPaths = Object.keys(paths).length > 0;
  const isStreaming = raw.isStreaming === true;
  return {
    success: raw.success,
    isStreaming,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels,
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
    ...(resolvedLanguages.length > 0 ? { languages: resolvedLanguages } : {}),
    ...(quantization != null ? { quantization } : {}),
    ...(detectionSources.length > 0 ? { detectionSources } : {}),
    ...(hasPaths ? { paths } : {}),
  };
}
