import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectSeparationModel,
  type SeparationConcreteModelType,
} from 'react-native-sherpa-onnx/separation';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import type { SeparationCustomPathKey } from './separationCustomInitLabels';

export type FillSeparationCustomConfigResult = {
  modelType: SeparationConcreteModelType;
  customConfig: Partial<Record<SeparationCustomPathKey, FileSource>>;
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

function toFsSource(path: string | undefined): FileSource | undefined {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

function isConcreteSeparationModelType(
  value: string
): value is SeparationConcreteModelType {
  return value === 'spleeter' || value === 'uvr';
}

function scanPathForKey(files: string[], key: SeparationCustomPathKey): string {
  if (key === 'vocals') {
    return (
      findOnnxByTokens(files, ['vocal']) || findOnnxByTokens(files, ['vocals'])
    );
  }
  if (key === 'accompaniment') {
    return (
      findOnnxByTokens(files, ['accompaniment', 'accomp', 'instrumental']) ||
      findOnnxByTokens(files, ['no_vocals', 'other'])
    );
  }
  return (
    findOnnxByTokens(files, ['uvr', 'mdx', 'model']) ||
    files.find((file) => file.toLowerCase().endsWith('.onnx')) ||
    ''
  );
}

export async function fillSeparationCustomConfigFromModelFolder(
  modelSource: FileSource,
  options?: { modelTypeOverride?: SeparationConcreteModelType }
): Promise<FillSeparationCustomConfigResult> {
  const detectResult = await detectSeparationModel(modelSource, {
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
    isConcreteSeparationModelType(detectResult.modelType)
      ? detectResult.modelType
      : detectResult.detectedModels[0]?.type);

  if (!rawType || !isConcreteSeparationModelType(rawType)) {
    throw new Error(
      'Could not determine a concrete separation model type for fill'
    );
  }

  const modelType = rawType;
  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);
  const detectPaths = detectResult.paths;

  const schema = await getCustomModelPathRequirements('separation', modelType);
  const customConfig: Partial<Record<SeparationCustomPathKey, FileSource>> = {};
  for (const field of schema.fields) {
    const key = field.key as SeparationCustomPathKey;
    const fromDetect =
      key === 'vocals'
        ? detectPaths?.vocals
        : key === 'accompaniment'
        ? detectPaths?.accompaniment
        : detectPaths?.model;
    const scanned = scanPathForKey(files, key);
    const source = toFsSource(fromDetect) ?? toFsSource(scanned);
    if (source) {
      customConfig[key] = source;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as SeparationCustomPathKey] == null
  );

  return {
    modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}
