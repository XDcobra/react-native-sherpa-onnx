import type {
  SpeakerEmbeddingAutoInitializeOptions,
  SpeakerEmbeddingCustomInitializeOptions,
  SpeakerEmbeddingInitializeOptions,
} from './types';
import type { SpeakerEmbeddingInitBridgeOptions } from '../nativeBridge/initBridgeTypes';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import { resolveSpeakerEmbeddingCustomConfigPaths } from './customConfig';

export type { SpeakerEmbeddingInitBridgeOptions };

function appendSharedInitBridgeFields(
  options: SpeakerEmbeddingInitializeOptions
): Omit<
  SpeakerEmbeddingInitBridgeOptions,
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

export async function buildSpeakerEmbeddingInitBridgeOptions(
  options: SpeakerEmbeddingInitializeOptions
): Promise<SpeakerEmbeddingInitBridgeOptions> {
  const sharedFields = appendSharedInitBridgeFields(options);

  if (options.initMode === 'custom') {
    const customOptions = options as SpeakerEmbeddingCustomInitializeOptions;
    const modelPaths = await resolveSpeakerEmbeddingCustomConfigPaths(
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

  const autoOptions = options as SpeakerEmbeddingAutoInitializeOptions;
  const modelDir = await resolveFileSourceForModelInit(autoOptions.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType: autoOptions.modelType ?? 'auto',
    ...sharedFields,
  };
}

/** Cache key identity derived from resolved bridge options. */
export function speakerEmbeddingEngineCacheKeyFromBridgeOptions(
  bridgeOptions: SpeakerEmbeddingInitBridgeOptions
): string {
  const modelKey =
    bridgeOptions.initMode === 'custom'
      ? String(
          (bridgeOptions.modelPaths as { model?: string } | undefined)?.model ??
            ''
        )
      : String(bridgeOptions.modelDir ?? '');
  return JSON.stringify({
    modelKey,
    provider: bridgeOptions.provider ?? 'cpu',
    numThreads: bridgeOptions.numThreads ?? 1,
  });
}
