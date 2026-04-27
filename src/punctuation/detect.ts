import SherpaOnnx from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { resolveFileSourceForDetect } from '../detect';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import {
  isDetectionSource,
  type DetectedModelEntry,
  type DetectionSource,
  type PunctuationDetectModelResult,
} from '../types/modelDetect';

export type PunctuationModelType = 'ct_transformer' | 'cnn_bilstm' | 'auto';

/**
 * Detect punctuation model layout (offline CT-Transformer vs online CNN-BiLSTM) without running inference.
 * `isStreaming` is forwarded from native detection: true when CNN-BiLSTM (online) is selected and the
 * ORT online-compatibility preflight passes; false for offline CT-Transformer and failed guards.
 */
export async function detectPunctuationModel(
  source: FileSource,
  options?: { modelType?: PunctuationModelType; assetName?: string }
): Promise<PunctuationDetectModelResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectPunctuationModel(
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
  const rawLanguageStrings =
    Array.isArray(raw.languages) && raw.languages.length > 0
      ? raw.languages.filter((x): x is string => typeof x === 'string')
      : [];
  const resolvedLanguages = resolvePublicLanguageHints({
    domain: ModelCategory.Punctuation,
    modelType: raw.modelType,
    rawFromNative: rawLanguageStrings,
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
  const paths = raw.paths;
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
    ...(paths != null
      ? {
          paths: {
            ...(typeof paths.ct_transformer === 'string' &&
            paths.ct_transformer.length > 0
              ? { ct_transformer: paths.ct_transformer }
              : {}),
            ...(typeof paths.cnn_bilstm === 'string' &&
            paths.cnn_bilstm.length > 0
              ? { cnn_bilstm: paths.cnn_bilstm }
              : {}),
            ...(typeof paths.bpe_vocab === 'string' &&
            paths.bpe_vocab.length > 0
              ? { bpe_vocab: paths.bpe_vocab }
              : {}),
          },
        }
      : {}),
  };
}
