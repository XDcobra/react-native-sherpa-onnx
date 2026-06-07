import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { OfflinePunctuationConcreteModelType } from './types';
import type { StreamingPunctuationConcreteModelType } from './streamingTypes';

export const PunctuationErrorCode = {
  INVALID_ARGUMENT: 'PUNCTUATION_INVALID_ARGUMENT',
} as const;

export type OfflinePunctuationCustomPathKey = 'ct_transformer';

export type StreamingPunctuationCustomPathKey = 'cnn_bilstm' | 'bpe_vocab';

export interface OfflinePunctuationCustomConfig {
  ct_transformer: FileSource;
}

export interface StreamingPunctuationCustomConfig {
  cnn_bilstm: FileSource;
  bpe_vocab: FileSource;
}

export function assertOfflinePunctuationCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, PunctuationErrorCode.INVALID_ARGUMENT);
}

export function assertStreamingPunctuationCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, PunctuationErrorCode.INVALID_ARGUMENT);
}

export async function resolveOfflinePunctuationCustomConfigPaths(
  modelType: OfflinePunctuationConcreteModelType,
  customConfig: OfflinePunctuationCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Punctuation,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: PunctuationErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for offline punctuation modelType '${mt}'`,
  });
}

export async function resolveStreamingPunctuationCustomConfigPaths(
  modelType: StreamingPunctuationConcreteModelType,
  customConfig: StreamingPunctuationCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Punctuation,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: PunctuationErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for streaming punctuation modelType '${mt}'`,
  });
}
