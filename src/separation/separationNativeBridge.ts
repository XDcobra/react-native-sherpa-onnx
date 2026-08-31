import type {
  SeparationAutoInitializeOptions,
  SeparationCustomInitializeOptions,
  SeparationInitializeOptions,
} from './types';
import type { SeparationInitBridgeOptions } from '../nativeBridge/initBridgeTypes';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { resolveSeparationCustomConfigPaths } from './customConfig';

export type { SeparationInitBridgeOptions };

function appendSharedInitBridgeFields(
  options: SeparationInitializeOptions
): Omit<
  SeparationInitBridgeOptions,
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

export async function buildSeparationInitBridgeOptions(
  options: SeparationInitializeOptions
): Promise<SeparationInitBridgeOptions> {
  const sharedFields = appendSharedInitBridgeFields(options);

  if (options.initMode === 'custom') {
    const customOptions = options as SeparationCustomInitializeOptions;
    const modelPaths = await resolveSeparationCustomConfigPaths(
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

  const autoOptions = options as SeparationAutoInitializeOptions;
  const modelDir = await resolveFileSourceForModelInit(autoOptions.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType: autoOptions.modelType ?? 'auto',
    ...sharedFields,
  };
}
