import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { AudioTaggingConcreteModelType } from './types';
import { AudioTaggingErrorCode } from './types';

export type AudioTaggingCustomPathKey = 'model' | 'labels';

export interface AudioTaggingCustomConfig {
  model: FileSource;
  labels: FileSource;
}

export function assertAudioTaggingCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, AudioTaggingErrorCode.INVALID_ARGUMENT);
}

export async function resolveAudioTaggingCustomConfigPaths(
  modelType: AudioTaggingConcreteModelType,
  customConfig: AudioTaggingCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.AudioTagging,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: AudioTaggingErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for audio tagging modelType '${mt}'`,
  });
}
