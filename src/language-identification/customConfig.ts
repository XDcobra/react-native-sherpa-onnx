import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import { LanguageIdErrorCode } from './types';
import type { LanguageIdConcreteModelType } from './types';

export type LanguageIdCustomPathKey = 'encoder' | 'decoder';

export interface LanguageIdCustomConfig {
  encoder: FileSource;
  decoder: FileSource;
}

export function assertLanguageIdCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, LanguageIdErrorCode.INVALID_ARGUMENT);
}

export async function resolveLanguageIdCustomConfigPaths(
  modelType: LanguageIdConcreteModelType,
  customConfig: LanguageIdCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.LanguageId,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: LanguageIdErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for language identification modelType '${mt}'`,
  });
}
