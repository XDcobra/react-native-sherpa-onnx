import SherpaOnnx from '../NativeSherpaOnnx';
import type { FileSource } from '../fileio/types';
import { resolveModelPath } from '../utils';
import { resolveFileSourceForDetect } from '../detect';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import { isDetectionSource } from './types';
import { resolvePipelineAudioBufferId } from '../audiobuffer';
import type {
  DetectedModelEntry,
  DetectionSource,
  EnhancementDetectResult,
  EnhancementEngine,
  EnhancementInitializeOptions,
} from './types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';

let enhancementInstanceCounter = 0;

export async function detectEnhancementModel(
  source: FileSource,
  options?: {
    modelType?: EnhancementInitializeOptions['modelType'];
    assetName?: string;
  }
): Promise<EnhancementDetectResult> {
  const resolved = await resolveFileSourceForDetect(source);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : resolved.assetName;
  const raw = await SherpaOnnx.detectEnhancementModel(
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
    domain: ModelCategory.Enhancement,
    modelType: raw.modelType,
    rawFromNative: rawLanguageStrings,
  });
  const quantization =
    typeof raw.quantization === 'string' && raw.quantization.length > 0
      ? raw.quantization
      : undefined;
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
  };
}

export async function createEnhancement(
  options: EnhancementInitializeOptions
): Promise<EnhancementEngine> {
  const instanceId = `enhancement_${++enhancementInstanceCounter}`;
  const resolvedPath = await resolveModelPath(options.modelPath);
  const init = await SherpaOnnx.initializeEnhancement(
    instanceId,
    resolvedPath,
    options.modelType ?? 'auto',
    options.numThreads,
    options.provider,
    options.debug
  );

  if (!init.success) {
    const nativeError = typeof init.error === 'string' ? init.error.trim() : '';
    throw new Error(
      nativeError.length > 0
        ? `Enhancement initialization failed: ${nativeError}`
        : `Enhancement initialization failed for ${instanceId}`
    );
  }

  let destroyed = false;
  const guard = () => {
    if (destroyed) {
      throw new Error(
        `Enhancement instance ${instanceId} has been destroyed; cannot call methods on it.`
      );
    }
  };

  return {
    get instanceId() {
      return instanceId;
    },
    async enhance(
      audioIn: OfflineAudioBufferIdSource,
      audioOut: OfflineAudioBufferIdSource
    ): Promise<void> {
      guard();
      const inId = resolvePipelineAudioBufferId(audioIn);
      const outId = resolvePipelineAudioBufferId(audioOut);
      await SherpaOnnx.enhanceOfflineAudioBuffers(instanceId, inId, outId);
    },
    async getSampleRate(): Promise<number> {
      guard();
      return SherpaOnnx.getEnhancementSampleRate(instanceId);
    },
    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await SherpaOnnx.unloadEnhancement(instanceId);
    },
  };
}

export { createStreamingEnhancement } from './streaming';
export type {
  StreamingEnhancementEngine,
  StreamingEnhancementInitializeOptions,
  EnhancementPipelineHandle,
} from './streamingTypes';

export type {
  EnhancementModelType,
  EnhancementInitializeOptions,
  EnhancementDetectResult,
  EnhancementEngine,
} from './types';
export { ENHANCEMENT_MODEL_TYPES } from './types';
