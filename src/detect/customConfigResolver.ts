import type { FileSource } from '../fileio/types';
import { resolveModelFileSources } from './resolveModelInput';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
  type CustomModelPathCategory,
} from './validateCustomModelPaths';

export function isFileSource(value: unknown): value is FileSource {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string';
}

export function createInvalidArgumentError(
  errorCode: string,
  message: string
): never {
  const err = new Error(`${errorCode}: ${message}`) as Error & {
    code?: string;
  };
  err.code = errorCode;
  throw err;
}

/** Structural check: every present customConfig value must be a FileSource. */
export function assertCustomModelConfig(
  customConfig: Record<string, unknown>,
  errorCode: string
): void {
  for (const [key, value] of Object.entries(customConfig)) {
    if (!isFileSource(value)) {
      createInvalidArgumentError(
        errorCode,
        `customConfig.${key} must be a FileSource object`
      );
    }
  }
}

export async function resolveCustomModelConfigPaths(args: {
  category: CustomModelPathCategory | string;
  modelType: string;
  customConfig: Readonly<Record<string, unknown>>;
  errorCode: string;
  unknownKeyMessage?: (key: string, modelType: string) => string;
}): Promise<Record<string, string>> {
  const {
    category,
    modelType,
    customConfig,
    errorCode,
    unknownKeyMessage = (key, mt) =>
      `Unknown customConfig key '${key}' for modelType '${mt}'`,
  } = args;

  assertCustomModelConfig(customConfig, errorCode);

  const schema = await getCustomModelPathRequirements(category, modelType);
  const allowedKeys = new Set([...schema.required, ...schema.optional]);
  for (const key of Object.keys(customConfig)) {
    if (!allowedKeys.has(key)) {
      createInvalidArgumentError(errorCode, unknownKeyMessage(key, modelType));
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
    category,
    modelType,
    resolvedPaths
  );
  if (!validation.ok) {
    createInvalidArgumentError(
      errorCode,
      validation.error?.trim() ||
        `Missing required paths: ${(validation.missingRequired ?? []).join(
          ', '
        )}`
    );
  }

  return resolvedPaths;
}
