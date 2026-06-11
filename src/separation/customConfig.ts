import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { SeparationModelType } from './types';

export const SeparationErrorCode = {
  INVALID_ARGUMENT: 'SEPARATION_INVALID_ARGUMENT',
} as const;

export type SpleeterCustomPathKey = 'vocals' | 'accompaniment';

export type UvrCustomPathKey = 'model';

export interface SpleeterCustomConfig {
  vocals: FileSource;
  accompaniment: FileSource;
}

export interface UvrCustomConfig {
  model: FileSource;
}

export function assertSeparationCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, SeparationErrorCode.INVALID_ARGUMENT);
}

export async function resolveSpleeterCustomConfigPaths(
  customConfig: SpleeterCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Separation,
    modelType: 'spleeter',
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: SeparationErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key) =>
      `Unknown customConfig key '${key}' for separation modelType 'spleeter'`,
  });
}

export async function resolveUvrCustomConfigPaths(
  customConfig: UvrCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Separation,
    modelType: 'uvr',
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: SeparationErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key) =>
      `Unknown customConfig key '${key}' for separation modelType 'uvr'`,
  });
}

export async function resolveSeparationCustomConfigPaths(
  modelType: SeparationModelType,
  customConfig: SpleeterCustomConfig | UvrCustomConfig
): Promise<Record<string, string>> {
  if (modelType === 'spleeter') {
    return resolveSpleeterCustomConfigPaths(
      customConfig as SpleeterCustomConfig
    );
  }
  return resolveUvrCustomConfigPaths(customConfig as UvrCustomConfig);
}
