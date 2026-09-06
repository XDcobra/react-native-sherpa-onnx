import SherpaOnnx from '../NativeSherpaOnnx';
import { resolveFileSourceForDetect } from '../detect/resolveModelInput';
import {
  publicLanguageHintsFromNative,
  readPublicLanguageRows,
} from '../model-languages';
import { ModelCategory } from '../download/types';
import type { FileSource } from '../fileio/types';
import { isDetectionSource } from './types';
import type {
  DetectedModelEntry,
  DetectionSource,
  DiarizationDetectResult,
  DiarizationModelKind,
} from './types';

export async function detectDiarizationModel(
  source: FileSource,
  options?: {
    modelType?: DiarizationModelKind | 'auto';
    assetName?: string;
  }
): Promise<DiarizationDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectDiarizationModel(
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
    domain: ModelCategory.Diarization,
    modelType: raw.modelType,
    rawRows: readPublicLanguageRows(raw.languages),
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const modelFilePath =
    typeof raw.paths?.model === 'string' ? raw.paths.model.trim() : '';
  const metadataFilePath =
    typeof raw.paths?.metadata === 'string' ? raw.paths.metadata.trim() : '';
  const paths: { model?: string; metadata?: string } = {};
  if (modelFilePath.length > 0) {
    paths.model = modelFilePath;
  }
  if (metadataFilePath.length > 0) {
    paths.metadata = metadataFilePath;
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
