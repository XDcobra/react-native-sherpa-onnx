import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import { DiarizationErrorCode } from './types';
import type { DiarizationConcreteModelType } from './types';

export type DiarizationCustomPathKey = 'model' | 'metadata';

export interface DiarizationCustomConfig {
  model: FileSource;
  metadata?: FileSource;
}

/**
 * Structural check: every present customConfig value must be a FileSource.
 * @throws {Error} `DIARIZATION_INVALID_ARGUMENT` — a customConfig value is not a FileSource.
 */
export function assertDiarizationCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, DiarizationErrorCode.INVALID_ARGUMENT);
}

export async function resolveDiarizationCustomConfigPaths(
  modelType: DiarizationConcreteModelType,
  customConfig: DiarizationCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Diarization,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: DiarizationErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for diarization modelType '${mt}'`,
  });
}
