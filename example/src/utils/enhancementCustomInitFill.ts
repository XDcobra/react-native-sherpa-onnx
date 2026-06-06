import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectEnhancementModel,
  type EnhancementConcreteModelType,
  type EnhancementCustomPathKey,
} from 'react-native-sherpa-onnx/enhancement';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

export type FillEnhancementCustomConfigResult = {
  modelType: EnhancementConcreteModelType;
  customConfig: Partial<Record<EnhancementCustomPathKey, FileSource>>;
  missingKeys: readonly string[];
  modelDir: string;
};

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? path;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  if (!(await exists(dir))) {
    return [];
  }
  const entries = await readDir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(entry.path)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entry.path);
    }
  }
  return files;
}

function findOnnxByTokens(files: string[], tokens: string[]): string {
  const onnxFiles = files.filter((file) =>
    file.toLowerCase().endsWith('.onnx')
  );
  const matches = onnxFiles.filter((file) => {
    const lower = basename(file).toLowerCase();
    return tokens.some((token) => lower.includes(token.toLowerCase()));
  });
  return matches[0] ?? '';
}

function scanEnhancementModelPath(
  files: string[],
  modelType: EnhancementConcreteModelType
): string {
  const tokens =
    modelType === 'dpdfnet'
      ? ['dpdf', 'dpdfnet']
      : ['gtcrn', 'enhancement', 'denois'];
  return (
    findOnnxByTokens(files, tokens) ||
    files.find((file) => file.toLowerCase().endsWith('.onnx')) ||
    ''
  );
}

function toFsSource(path: string): FileSource | undefined {
  const trimmed = path.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

function isConcreteEnhancementModelType(
  value: string
): value is EnhancementConcreteModelType {
  return value === 'gtcrn' || value === 'dpdfnet';
}

export async function fillEnhancementCustomConfigFromModelFolder(
  modelSource: FileSource,
  options?: { modelTypeOverride?: EnhancementConcreteModelType }
): Promise<FillEnhancementCustomConfigResult> {
  const detectResult = await detectEnhancementModel(modelSource, {
    modelType: options?.modelTypeOverride ?? 'auto',
  });
  if (!detectResult.success) {
    throw new Error(
      detectResult.error?.trim() || 'Model detection failed for fill helper'
    );
  }

  const rawType =
    options?.modelTypeOverride ??
    (detectResult.modelType &&
    isConcreteEnhancementModelType(detectResult.modelType)
      ? detectResult.modelType
      : detectResult.detectedModels[0]?.type);

  if (!rawType || !isConcreteEnhancementModelType(rawType)) {
    throw new Error(
      'Could not determine a concrete enhancement model type for fill'
    );
  }

  const modelType = rawType;
  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);
  const modelPath = scanEnhancementModelPath(files, modelType);

  const schema = await getCustomModelPathRequirements('enhancement', modelType);
  const customConfig: Partial<Record<EnhancementCustomPathKey, FileSource>> =
    {};
  for (const field of schema.fields) {
    const source = field.key === 'model' ? toFsSource(modelPath) : undefined;
    if (source) {
      customConfig[field.key as EnhancementCustomPathKey] = source;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as EnhancementCustomPathKey] == null
  );

  return {
    modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}
