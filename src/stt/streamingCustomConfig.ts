import type { FileSource } from '../fileio/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { OnlineSTTModelType } from './streamingTypes';
import { SttErrorCode } from './types';

export type StreamingSttCustomPathKey =
  | 'encoder'
  | 'decoder'
  | 'joiner'
  | 'tokens'
  | 'model';

export interface StreamingTransducerCustomConfig {
  encoder: FileSource;
  decoder: FileSource;
  joiner: FileSource;
  tokens: FileSource;
}

export interface StreamingParaformerCustomConfig {
  encoder: FileSource;
  decoder: FileSource;
  tokens: FileSource;
}

export interface StreamingSingleModelCustomConfig {
  model: FileSource;
  tokens: FileSource;
}

export type StreamingSttCustomConfigByModelType = {
  transducer: StreamingTransducerCustomConfig;
  nemo_transducer: StreamingTransducerCustomConfig;
  paraformer: StreamingParaformerCustomConfig;
  zipformer2_ctc: StreamingSingleModelCustomConfig;
  nemo_ctc: StreamingSingleModelCustomConfig;
  tone_ctc: StreamingSingleModelCustomConfig;
};

export type StreamingSttCustomConfig =
  StreamingSttCustomConfigByModelType[OnlineSTTModelType];

const STREAMING_STT_CATEGORY = 'stt_streaming';

export function assertStreamingSttCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, SttErrorCode.INVALID_ARGUMENT);
}

export async function resolveStreamingSttCustomConfigPaths(
  modelType: OnlineSTTModelType,
  customConfig: StreamingSttCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: STREAMING_STT_CATEGORY,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: SttErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for streaming modelType '${mt}'`,
  });
}
