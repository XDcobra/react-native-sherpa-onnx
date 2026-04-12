import SherpaOnnx from '../NativeSherpaOnnx';
import type { ModelPathConfig } from '../types';
import { resolveModelPath, deriveAssetNameFromModelPath } from '../utils';
import { resolvePublicLanguageHints } from '../model-languages';
import { ModelCategory } from '../download/types';
import { isDetectionSource } from './types';
import type {
  DetectedModelEntry,
  DetectionSource,
  EnhancementDetectResult,
  EnhancementEngine,
  EnhancementInitializeOptions,
} from './types';
import type { OfflineAudioBufferIdSource } from '../audiobuffer/types';

let enhancementInstanceCounter = 0;

function resolveOfflineAudioBufferId(
  source: OfflineAudioBufferIdSource
): string {
  if (typeof source === 'object' && source !== null && 'info' in source) {
    return (source as { bufferId: string }).bufferId;
  }
  return source as string;
}

export async function detectEnhancementModel(
  modelPath: ModelPathConfig,
  options?: {
    modelType?: EnhancementInitializeOptions['modelType'];
    assetName?: string;
  }
): Promise<EnhancementDetectResult> {
  const resolvedPath = await resolveModelPath(modelPath);
  const optionAssetName = options?.assetName?.trim();
  const assetName =
    optionAssetName && optionAssetName.length > 0
      ? optionAssetName
      : deriveAssetNameFromModelPath(modelPath);
  const raw = await SherpaOnnx.detectEnhancementModel(
    resolvedPath,
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
  return {
    success: raw.success,
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
      const inId = resolveOfflineAudioBufferId(audioIn);
      const outId = resolveOfflineAudioBufferId(audioOut);
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
  OnlineEnhancementEngine,
  StreamingEnhancementInitializeOptions,
} from './streamingTypes';

export type {
  EnhancementModelType,
  EnhancedAudio,
  EnhancementInitializeOptions,
  EnhancementDetectResult,
  EnhancementEngine,
} from './types';
export { ENHANCEMENT_MODEL_TYPES } from './types';
