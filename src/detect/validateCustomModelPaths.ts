import { ModelCategory } from '../download/types';
import NativeSherpaOnnx from '../NativeSherpaOnnx';

export type CustomModelPathCategory =
  | ModelCategory.Stt
  | ModelCategory.Tts
  | ModelCategory.Vad
  | ModelCategory.Enhancement
  | ModelCategory.Punctuation
  | ModelCategory.Alignment;

export type CustomModelPathValidationResult = {
  ok: boolean;
  error?: string;
  missingRequired?: string[];
};

export type CustomModelPathRequirements = {
  required: string[];
  optional: string[];
};

function normalizeCategory(category: CustomModelPathCategory | string): string {
  return typeof category === 'string' ? category : category;
}

export async function validateCustomModelPaths(
  category: CustomModelPathCategory | string,
  modelType: string,
  paths: Readonly<Record<string, string>>
): Promise<CustomModelPathValidationResult> {
  const raw = await NativeSherpaOnnx.validateCustomModelPaths(
    normalizeCategory(category),
    modelType,
    paths
  );
  return {
    ok: raw.ok ?? false,
    error: raw.error,
    missingRequired: raw.missingRequired,
  };
}

export async function getCustomModelPathRequirements(
  category: CustomModelPathCategory | string,
  modelType: string
): Promise<CustomModelPathRequirements> {
  const raw = await NativeSherpaOnnx.getCustomModelPathRequirements(
    normalizeCategory(category),
    modelType
  );
  return {
    required: raw.required ?? [],
    optional: raw.optional ?? [],
  };
}
