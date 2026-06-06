import type { FileSource } from '../fileio/types';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../detect/validateCustomModelPaths';
import { resolveModelFileSources } from '../detect/resolveModelInput';
import type { OnlineSTTModelType } from './streamingTypes';
import { SttErrorCode } from './types';

export type StreamingSttCustomPathKey =
  | 'encoder'
  | 'decoder'
  | 'joiner'
  | 'tokens'
  | 'model';

export interface StreamingTransducerCustomConfig {
  encoder: FileSource;
  decoder: FileSource;
  joiner: FileSource;
  tokens: FileSource;
}

export interface StreamingParaformerCustomConfig {
  encoder: FileSource;
  decoder: FileSource;
  tokens: FileSource;
}

export interface StreamingSingleModelCustomConfig {
  model: FileSource;
  tokens: FileSource;
}

export type StreamingSttCustomConfigByModelType = {
  transducer: StreamingTransducerCustomConfig;
  nemo_transducer: StreamingTransducerCustomConfig;
  paraformer: StreamingParaformerCustomConfig;
  zipformer2_ctc: StreamingSingleModelCustomConfig;
  wenet_ctc: StreamingSingleModelCustomConfig;
  nemo_ctc: StreamingSingleModelCustomConfig;
  tone_ctc: StreamingSingleModelCustomConfig;
};

export type StreamingSttCustomConfig =
  StreamingSttCustomConfigByModelType[OnlineSTTModelType];

const STREAMING_STT_CATEGORY = 'stt_streaming';

function createStreamingInvalidArgumentError(message: string): never {
  const err = new Error(
    `${SttErrorCode.INVALID_ARGUMENT}: ${message}`
  ) as Error & { code?: string };
  err.code = SttErrorCode.INVALID_ARGUMENT;
  throw err;
}

function isFileSource(value: unknown): value is FileSource {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string';
}

export function assertStreamingSttCustomConfig(
  customConfig: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(customConfig)) {
    if (!isFileSource(value)) {
      createStreamingInvalidArgumentError(
        `customConfig.${key} must be a FileSource object`
      );
    }
  }
}

export async function resolveStreamingSttCustomConfigPaths(
  modelType: OnlineSTTModelType,
  customConfig: StreamingSttCustomConfig
): Promise<Record<string, string>> {
  assertStreamingSttCustomConfig(
    customConfig as unknown as Record<string, unknown>
  );

  const schema = await getCustomModelPathRequirements(
    STREAMING_STT_CATEGORY,
    modelType
  );
  const allowedKeys = new Set([...schema.required, ...schema.optional]);
  for (const key of Object.keys(customConfig)) {
    if (!allowedKeys.has(key)) {
      createStreamingInvalidArgumentError(
        `Unknown customConfig key '${key}' for streaming modelType '${modelType}'`
      );
    }
  }

  const fileSources: Record<string, FileSource> = {};
  for (const [key, value] of Object.entries(customConfig)) {
    if (isFileSource(value)) {
      fileSources[key] = value;
    }
  }
  const resolvedPaths = await resolveModelFileSources(fileSources);

  const validation = await validateCustomModelPaths(
    STREAMING_STT_CATEGORY,
    modelType,
    resolvedPaths
  );
  if (!validation.ok) {
    createStreamingInvalidArgumentError(
      validation.error?.trim() ||
        `Missing required paths: ${(validation.missingRequired ?? []).join(
          ', '
        )}`
    );
  }

  return resolvedPaths;
}
