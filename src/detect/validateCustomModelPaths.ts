import { ModelCategory } from '../download/types';
import NativeSherpaOnnx from '../NativeSherpaOnnx';
import type {
  CustomModelPathField,
  CustomModelPathRequirements,
} from './customModelPathRequirements';

export type {
  CustomModelPathField,
  CustomModelPathFieldKind,
  CustomModelPathRequirements,
} from './customModelPathRequirements';

export {
  customModelPathFieldKeys,
  requiredCustomModelPathFieldKeys,
} from './customModelPathRequirements';

export type CustomModelPathCategory =
  | ModelCategory.Stt
  | 'stt_streaming'
  | ModelCategory.Tts
  | ModelCategory.Vad
  | ModelCategory.Enhancement
  | ModelCategory.Separation
  | ModelCategory.SpeakerEmbedding
  | ModelCategory.Diarization
  | ModelCategory.Punctuation
  | ModelCategory.Alignment;

export type CustomModelPathValidationResult = {
  ok: boolean;
  error?: string;
  missingRequired?: string[];
};

type NativeCustomModelPathField = {
  key?: string;
  required?: boolean;
  kind?: string;
};

type NativeCustomModelPathRequirements = {
  fields?: NativeCustomModelPathField[];
};

function normalizeCategory(category: CustomModelPathCategory | string): string {
  return typeof category === 'string' ? category : category;
}

function normalizeCustomModelPathField(
  field: NativeCustomModelPathField
): CustomModelPathField | null {
  if (!field.key) return null;
  return {
    key: field.key,
    required: field.required ?? false,
    kind: field.kind === 'dir' ? 'dir' : 'file',
  };
}

function normalizeCustomModelPathRequirements(
  raw: NativeCustomModelPathRequirements
): CustomModelPathRequirements {
  const fields = (raw.fields ?? [])
    .map(normalizeCustomModelPathField)
    .filter((field): field is CustomModelPathField => field != null);

  return { fields };
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
  return normalizeCustomModelPathRequirements(raw);
}
