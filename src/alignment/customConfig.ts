import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { AlignmentConcreteModelType } from './types';

export const AlignmentErrorCode = {
  INVALID_ARGUMENT: 'ALIGNMENT_INVALID_ARGUMENT',
} as const;

export type AlignmentCustomPathKey = 'model';

export interface AlignmentCustomConfig {
  model: FileSource;
}

export function assertAlignmentCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, AlignmentErrorCode.INVALID_ARGUMENT);
}

export async function resolveAlignmentCustomConfigPaths(
  modelType: AlignmentConcreteModelType,
  customConfig: AlignmentCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Alignment,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: AlignmentErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for alignment modelType '${mt}'`,
  });
}
