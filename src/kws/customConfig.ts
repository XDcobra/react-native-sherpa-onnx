import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { KwsConcreteModelType } from './types';

export const KwsErrorCode = {
  INVALID_ARGUMENT: 'KWS_INVALID_ARGUMENT',
} as const;

export type KwsCustomPathKey =
  | 'encoder'
  | 'decoder'
  | 'joiner'
  | 'tokens'
  | 'keywords';

export interface KwsCustomConfig {
  encoder: FileSource;
  decoder: FileSource;
  joiner: FileSource;
  tokens: FileSource;
  keywords: FileSource;
}

export function assertKwsCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, KwsErrorCode.INVALID_ARGUMENT);
}

export async function resolveKwsCustomConfigPaths(
  modelType: KwsConcreteModelType,
  customConfig: KwsCustomConfig
): Promise<Record<KwsCustomPathKey, string>> {
  const paths = await resolveCustomModelConfigPaths({
    category: ModelCategory.Kws,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: KwsErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for KWS modelType '${mt}'`,
  });
  return paths as Record<KwsCustomPathKey, string>;
}
