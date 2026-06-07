import type {
  VADAutoInitializeOptions,
  VADCustomInitializeOptions,
  VADInitializeOptions,
  VADModelType,
  VADRuntimeOptions,
  VADRuntimeTuningOptions,
} from './types';
import type { VadInitBridgeOptions } from '../nativeBridge/initBridgeTypes';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { resolveVadCustomConfigPaths } from './customConfig';

export type { VadInitBridgeOptions };

function flattenRuntimeTuning(
  tuning: VADRuntimeTuningOptions
): Pick<
  VadInitBridgeOptions,
  | 'threshold'
  | 'silenceDurationMs'
  | 'speechDurationMs'
  | 'minSpeechDurationMs'
  | 'maxSpeechDurationS'
  | 'windowSize'
> {
  return {
    ...(tuning.scoreThreshold !== undefined
      ? { threshold: tuning.scoreThreshold }
      : {}),
    ...(tuning.minSilenceDurationMs !== undefined
      ? { silenceDurationMs: tuning.minSilenceDurationMs }
      : {}),
    ...(tuning.minSpeechDurationMs !== undefined
      ? {
          speechDurationMs: tuning.minSpeechDurationMs,
          minSpeechDurationMs: tuning.minSpeechDurationMs,
        }
      : {}),
    ...(typeof tuning.maxSpeechDurationMs === 'number'
      ? { maxSpeechDurationS: tuning.maxSpeechDurationMs / 1000 }
      : {}),
    ...(tuning.windowSize !== undefined
      ? { windowSize: tuning.windowSize }
      : {}),
  };
}

function resolveRuntimeTuningOptions(
  runtimeOptions: VADRuntimeOptions | undefined,
  modelType: VADModelType
): VADRuntimeTuningOptions | undefined {
  if (!runtimeOptions) {
    return undefined;
  }
  if (modelType === 'silero_vad') {
    if ('sileroVad' in runtimeOptions) {
      return runtimeOptions.sileroVad;
    }
    throw Object.assign(
      new Error(
        'VAD runtime options mismatch: expected sileroVad options for silero_vad model'
      ),
      { code: 'VAD_INVALID_OPTIONS' }
    );
  }
  if ('tenVad' in runtimeOptions) {
    return runtimeOptions.tenVad;
  }
  throw Object.assign(
    new Error(
      'VAD runtime options mismatch: expected tenVad options for ten_vad model'
    ),
    { code: 'VAD_INVALID_OPTIONS' }
  );
}

function runtimeTuningFromOptions(
  runtimeOptions: VADRuntimeOptions | undefined,
  modelType: VADModelType | 'auto'
): VADRuntimeTuningOptions | undefined {
  if (!runtimeOptions) {
    return undefined;
  }
  if (modelType === 'auto') {
    if ('sileroVad' in runtimeOptions && runtimeOptions.sileroVad) {
      return runtimeOptions.sileroVad;
    }
    if ('tenVad' in runtimeOptions && runtimeOptions.tenVad) {
      return runtimeOptions.tenVad;
    }
    return undefined;
  }
  return resolveRuntimeTuningOptions(runtimeOptions, modelType);
}

function appendSharedInitBridgeFields(
  options: VADInitializeOptions,
  modelTypeForTuning: VADModelType | 'auto'
): Omit<
  VadInitBridgeOptions,
  'initMode' | 'modelDir' | 'modelPaths' | 'modelType'
> {
  const tuning = runtimeTuningFromOptions(
    options.runtimeOptions,
    modelTypeForTuning
  );
  const flat = tuning ? flattenRuntimeTuning(tuning) : {};
  return {
    ...(options.sampleRate !== undefined
      ? { sampleRate: options.sampleRate }
      : {}),
    ...flat,
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  };
}

export async function buildVadInitBridgeOptions(
  options: VADInitializeOptions
): Promise<VadInitBridgeOptions> {
  const sharedFields = appendSharedInitBridgeFields(
    options,
    options.initMode === 'custom'
      ? options.modelType
      : options.modelType ?? 'auto'
  );

  if (options.initMode === 'custom') {
    const customOptions = options as VADCustomInitializeOptions;
    const modelPaths = await resolveVadCustomConfigPaths(
      customOptions.modelType,
      customOptions.customConfig
    );
    return {
      initMode: 'custom',
      modelType: customOptions.modelType,
      modelPaths,
      ...sharedFields,
    };
  }

  const autoOptions = options as VADAutoInitializeOptions;
  const modelDir = await resolveFileSourceForModelInit(autoOptions.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType: autoOptions.modelType ?? 'auto',
    ...sharedFields,
  };
}
