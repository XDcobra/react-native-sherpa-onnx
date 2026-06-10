import type {
  OfflinePunctuationAutoInitializeOptions,
  OfflinePunctuationCustomInitializeOptions,
  OfflinePunctuationInitializeOptions,
} from './types';
import type {
  StreamingPunctuationAutoInitializeOptions,
  StreamingPunctuationCustomInitializeOptions,
  StreamingPunctuationInitializeOptions,
} from './streamingTypes';
import type { PunctuationInitBridgeOptions } from '../nativeBridge/initBridgeTypes';
import { resolveFileSourceForModelInit } from '../detect/resolveModelInput';
import {
  resolveOfflinePunctuationCustomConfigPaths,
  resolveStreamingPunctuationCustomConfigPaths,
} from './customConfig';

export type { PunctuationInitBridgeOptions };

type PunctuationInitScalars = Pick<
  PunctuationInitBridgeOptions,
  'numThreads' | 'provider' | 'debug'
>;

function appendSharedInitBridgeFields(
  options:
    | OfflinePunctuationInitializeOptions
    | StreamingPunctuationInitializeOptions
): PunctuationInitScalars {
  return {
    ...(options.numThreads !== undefined
      ? { numThreads: options.numThreads }
      : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.debug !== undefined ? { debug: options.debug } : {}),
  };
}

export async function buildOfflinePunctuationInitBridgeOptions(
  options: OfflinePunctuationInitializeOptions
): Promise<PunctuationInitBridgeOptions> {
  const sharedFields = appendSharedInitBridgeFields(options);

  if (options.initMode === 'custom') {
    const customOptions = options as OfflinePunctuationCustomInitializeOptions;
    const modelPaths = await resolveOfflinePunctuationCustomConfigPaths(
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

  const autoOptions = options as OfflinePunctuationAutoInitializeOptions;
  const modelDir = await resolveFileSourceForModelInit(autoOptions.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType: autoOptions.modelType ?? 'auto',
    ...sharedFields,
  };
}

export async function buildStreamingPunctuationInitBridgeOptions(
  options: StreamingPunctuationInitializeOptions
): Promise<PunctuationInitBridgeOptions> {
  const sharedFields = appendSharedInitBridgeFields(options);

  if (options.initMode === 'custom') {
    const customOptions =
      options as StreamingPunctuationCustomInitializeOptions;
    const modelPaths = await resolveStreamingPunctuationCustomConfigPaths(
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

  const autoOptions = options as StreamingPunctuationAutoInitializeOptions;
  const modelDir = await resolveFileSourceForModelInit(autoOptions.modelSource);
  return {
    initMode: 'auto',
    modelDir,
    modelType: autoOptions.modelType ?? 'auto',
    ...sharedFields,
  };
}
