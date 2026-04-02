import SherpaOnnx from '../NativeSherpaOnnx';
import type { ModelPathConfig } from '../types';
import { resolveModelPath } from '../utils';
import type {
  EnhancedAudio,
  EnhancementDetectResult,
  EnhancementEngine,
  EnhancementInitializeOptions,
} from './types';

let enhancementInstanceCounter = 0;

function normalizeEnhancedAudio(raw: {
  samples?: number[] | Float32Array;
  sampleRate?: number;
}): EnhancedAudio {
  const samplesArray = Array.isArray(raw.samples)
    ? raw.samples
    : Array.from(raw.samples ?? []);
  return {
    samples: Float32Array.from(samplesArray),
    sampleRate: Number(raw.sampleRate ?? 0),
  };
}

export async function detectEnhancementModel(
  modelPath: ModelPathConfig,
  options?: { modelType?: EnhancementInitializeOptions['modelType'] }
): Promise<EnhancementDetectResult> {
  const resolvedPath = await resolveModelPath(modelPath);
  const raw = await SherpaOnnx.detectEnhancementModel(
    resolvedPath,
    options?.modelType
  );
  const err = typeof raw.error === 'string' ? raw.error.trim() : '';
  return {
    success: raw.success,
    ...(err.length > 0 ? { error: err } : {}),
    detectedModels: raw.detectedModels ?? [],
    ...(raw.modelType != null && raw.modelType !== ''
      ? { modelType: raw.modelType }
      : {}),
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
    async enhanceFile(
      inputPath: string,
      outputPath?: string
    ): Promise<EnhancedAudio> {
      guard();
      const raw = await SherpaOnnx.enhanceFile(
        instanceId,
        inputPath,
        outputPath
      );
      return normalizeEnhancedAudio(raw);
    },
    async enhanceSamples(
      samples: number[],
      sampleRate: number
    ): Promise<EnhancedAudio> {
      guard();
      const raw = await SherpaOnnx.enhanceSamples(
        instanceId,
        samples,
        sampleRate
      );
      return normalizeEnhancedAudio(raw);
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
