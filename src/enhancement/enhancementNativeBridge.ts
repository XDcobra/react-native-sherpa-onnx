import type {
  EnhancementAutoInitializeOptions,
  EnhancementCustomInitializeOptions,
  EnhancementInitializeOptions,
} from './types';
import type { EnhancementInitBridgeOptions } from '../nativeBridge/initBridgeTypes';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { resolveEnhancementCustomConfigPaths } from './customConfig';

export type { EnhancementInitBridgeOptions };

function appendSharedInitBridgeFields(
  options: EnhancementInitializeOptions
): Omit<
  EnhancementInitBridgeOptions,
  'initMode' | 'modelDir' | 'modelPaths' | 'modelType'
> {
  return {
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  };
}

export async function buildEnhancementInitBridgeOptions(
  options: EnhancementInitializeOptions
): Promise<EnhancementInitBridgeOptions> {
  const sharedFields = appendSharedInitBridgeFields(options);

  if (options.initMode === 'custom') {
    const customOptions = options as EnhancementCustomInitializeOptions;
    const modelPaths = await resolveEnhancementCustomConfigPaths(
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

  const autoOptions = options as EnhancementAutoInitializeOptions;
  const modelDir = await resolveFileSourceForModelInit(autoOptions.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType: autoOptions.modelType ?? 'auto',
    ...sharedFields,
  };
}
