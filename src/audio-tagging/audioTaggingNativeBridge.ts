import type {
  AudioTaggingAutoInitializeOptions,
  AudioTaggingCustomInitializeOptions,
  AudioTaggingInitializeOptions,
} from './types';
import type { AudioTaggingInitBridgeOptions } from '../nativeBridge/initBridgeTypes';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { resolveAudioTaggingCustomConfigPaths } from './customConfig';

export type { AudioTaggingInitBridgeOptions };

function appendSharedInitBridgeFields(
  options: AudioTaggingInitializeOptions
): Omit<
  AudioTaggingInitBridgeOptions,
  'initMode' | 'modelDir' | 'modelPaths' | 'modelType'
> {
  return {
    ...(options.topK !== undefined ? { topK: options.topK } : {}),
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  };
}

export async function buildAudioTaggingInitBridgeOptions(
  options: AudioTaggingInitializeOptions
): Promise<AudioTaggingInitBridgeOptions> {
  const sharedFields = appendSharedInitBridgeFields(options);

  if (options.initMode === 'custom') {
    const customOptions = options as AudioTaggingCustomInitializeOptions;
    const modelPaths = await resolveAudioTaggingCustomConfigPaths(
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

  const autoOptions = options as AudioTaggingAutoInitializeOptions;
  const modelDir = await resolveFileSourceForModelInit(autoOptions.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType: autoOptions.modelType ?? 'auto',
    ...(autoOptions.quantization !== undefined
      ? { quantization: autoOptions.quantization }
      : {}),
    ...sharedFields,
  };
}
