import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectLanguageIdModel,
  type LanguageIdCustomPathKey,
  type LanguageIdModelType,
} from 'react-native-sherpa-onnx/language-identification';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { ModelCategory } from 'react-native-sherpa-onnx/download';

export type FillLanguageIdCustomConfigResult = {
  modelType: LanguageIdModelType;
  customConfig: Partial<Record<LanguageIdCustomPathKey, FileSource>>;
  missingKeys: readonly string[];
  modelDir: string;
};

function toFsSource(path: string | undefined): FileSource | undefined {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

export async function fillLanguageIdCustomConfigFromModelFolder(
  modelSource: FileSource
): Promise<FillLanguageIdCustomConfigResult> {
  const detectResult = await detectLanguageIdModel(modelSource, {
    modelType: 'auto',
  });
  if (!detectResult.success) {
    throw new Error(
      detectResult.error?.trim() || 'Model detection failed for fill helper'
    );
  }

  const modelType: LanguageIdModelType = 'whisper';
  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const detectPaths = detectResult.paths as
    | { encoder?: string; decoder?: string }
    | undefined;

  const schema = await getCustomModelPathRequirements(
    ModelCategory.LanguageId,
    modelType
  );
  const customConfig: Partial<Record<LanguageIdCustomPathKey, FileSource>> = {};
  for (const field of schema.fields) {
    const key = field.key as LanguageIdCustomPathKey;
    const fromDetect =
      key === 'encoder'
        ? detectPaths?.encoder
        : key === 'decoder'
        ? detectPaths?.decoder
        : undefined;
    const source = toFsSource(fromDetect);
    if (source) {
      customConfig[key] = source;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as LanguageIdCustomPathKey] == null
  );

  return {
    modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}
