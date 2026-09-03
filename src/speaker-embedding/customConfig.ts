import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { SpeakerEmbeddingConcreteModelType } from './types';

export const SpeakerEmbeddingErrorCode = {
  INVALID_ARGUMENT: 'SPEAKER_EMBEDDING_INVALID_ARGUMENT',
} as const;

export type SpeakerEmbeddingCustomPathKey = 'model';

export interface SpeakerEmbeddingCustomConfig {
  model: FileSource;
}

export function assertSpeakerEmbeddingCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(
    customConfig,
    SpeakerEmbeddingErrorCode.INVALID_ARGUMENT
  );
}

export async function resolveSpeakerEmbeddingCustomConfigPaths(
  modelType: SpeakerEmbeddingConcreteModelType,
  customConfig: SpeakerEmbeddingCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.SpeakerEmbedding,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: SpeakerEmbeddingErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for speaker embedding modelType '${mt}'`,
  });
}
