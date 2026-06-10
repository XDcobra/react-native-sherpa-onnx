import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { VADConcreteModelType } from './types';

export const VadErrorCode = {
  INVALID_ARGUMENT: 'VAD_INVALID_ARGUMENT',
} as const;

export type VadCustomPathKey = 'model';

export interface VadCustomConfig {
  model: FileSource;
}

export function assertVadCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, VadErrorCode.INVALID_ARGUMENT);
}

export async function resolveVadCustomConfigPaths(
  modelType: VADConcreteModelType,
  customConfig: VadCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Vad,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: VadErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for VAD modelType '${mt}'`,
  });
}
