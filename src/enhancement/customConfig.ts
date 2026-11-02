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

export type GtcrnDpdfnetCustomPathKey = 'model';

export type VoxLockCustomPathKey = 'enrollModel' | 'chunkModel';

export type EnhancementCustomPathKey =
  | GtcrnDpdfnetCustomPathKey
  | VoxLockCustomPathKey;

export interface GtcrnDpdfnetCustomConfig {
  model: FileSource;
}

export interface VoxLockCustomConfig {
  enrollModel: FileSource;
  chunkModel: FileSource;
}

export type EnhancementCustomConfig =
  | GtcrnDpdfnetCustomConfig
  | VoxLockCustomConfig;

/**
 * Structural check: every present customConfig value must be a FileSource.
 * @throws {Error} `ENHANCEMENT_INVALID_ARGUMENT` — a customConfig value is not a FileSource.
 */
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
