import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { EnhancementConcreteModelType } from './types';

export const EnhancementErrorCode = {
  INVALID_ARGUMENT: 'ENHANCEMENT_INVALID_ARGUMENT',
} as const;

export type EnhancementCustomPathKey = 'model';

export interface EnhancementCustomConfig {
  model: FileSource;
}

export function assertEnhancementCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, EnhancementErrorCode.INVALID_ARGUMENT);
}

export async function resolveEnhancementCustomConfigPaths(
  modelType: EnhancementConcreteModelType,
  customConfig: EnhancementCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Enhancement,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: EnhancementErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for enhancement modelType '${mt}'`,
  });
}
