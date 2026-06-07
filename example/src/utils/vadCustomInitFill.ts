import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectVadModel,
  type VADConcreteModelType,
  type VadCustomPathKey,
} from 'react-native-sherpa-onnx/vad';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

export type FillVadCustomConfigResult = {
  modelType: VADConcreteModelType;
  customConfig: Partial<Record<VadCustomPathKey, FileSource>>;
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

function scanVadModelPath(
  files: string[],
  modelType: VADConcreteModelType
): string {
  const tokens =
    modelType === 'ten_vad'
      ? ['ten', 'ten-vad', 'ten_vad']
      : ['silero', 'silero_vad', 'silero-vad', 'vad'];
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

function isConcreteVadModelType(value: string): value is VADConcreteModelType {
  return value === 'silero_vad' || value === 'ten_vad';
}

export async function fillVadCustomConfigFromModelFolder(
  modelSource: FileSource,
  options?: { modelTypeOverride?: VADConcreteModelType }
): Promise<FillVadCustomConfigResult> {
  const detectResult = await detectVadModel(modelSource, {
    modelType: options?.modelTypeOverride ?? 'auto',
  });
  if (!detectResult.success) {
    throw new Error(
      detectResult.error?.trim() || 'Model detection failed for fill helper'
    );
  }

  const rawType =
    options?.modelTypeOverride ??
    (detectResult.modelType && isConcreteVadModelType(detectResult.modelType)
      ? detectResult.modelType
      : detectResult.detectedModels[0]?.type);

  if (!rawType || !isConcreteVadModelType(rawType)) {
    throw new Error('Could not determine a concrete VAD model type for fill');
  }

  const modelType = rawType;
  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);
  const modelPath = scanVadModelPath(files, modelType);

  const schema = await getCustomModelPathRequirements('vad', modelType);
  const customConfig: Partial<Record<VadCustomPathKey, FileSource>> = {};
  for (const field of schema.fields) {
    const source = field.key === 'model' ? toFsSource(modelPath) : undefined;
    if (source) {
      customConfig[field.key as VadCustomPathKey] = source;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as VadCustomPathKey] == null
  );

  return {
    modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}
