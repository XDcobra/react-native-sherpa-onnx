import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectSpeakerEmbeddingModel,
  type SpeakerEmbeddingCustomPathKey,
  type SpeakerEmbeddingModelType,
} from 'react-native-sherpa-onnx/speaker-identification';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { ModelCategory } from 'react-native-sherpa-onnx/download';

export type FillSidCustomConfigResult = {
  modelType: SpeakerEmbeddingModelType;
  customConfig: Partial<Record<SpeakerEmbeddingCustomPathKey, FileSource>>;
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

function scanSidModelPath(files: string[]): string {
  return (
    findOnnxByTokens(files, [
      'wespeaker',
      '3d-speaker',
      '3dspeaker',
      'nemo',
      'speaker',
      'embedding',
    ]) ||
    files.find((file) => file.toLowerCase().endsWith('.onnx')) ||
    ''
  );
}

function toFsSource(path: string | undefined): FileSource | undefined {
  const trimmed = path?.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

function isConcreteSpeakerEmbeddingModelType(
  value: string
): value is SpeakerEmbeddingModelType {
  return value === 'wespeaker' || value === '3d-speaker' || value === 'nemo';
}

export async function fillSidCustomConfigFromModelFolder(
  modelSource: FileSource,
  options?: { modelTypeOverride?: SpeakerEmbeddingModelType }
): Promise<FillSidCustomConfigResult> {
  const detectResult = await detectSpeakerEmbeddingModel(modelSource, {
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
    isConcreteSpeakerEmbeddingModelType(detectResult.modelType)
      ? detectResult.modelType
      : detectResult.detectedModels[0]?.type);

  if (!rawType || !isConcreteSpeakerEmbeddingModelType(rawType)) {
    throw new Error(
      'Could not determine a concrete speaker-embedding model type for fill'
    );
  }

  const modelType = rawType;
  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);
  const detectPaths = detectResult.paths as { model?: string } | undefined;

  const schema = await getCustomModelPathRequirements(
    ModelCategory.SpeakerEmbedding,
    modelType
  );
  const customConfig: Partial<
    Record<SpeakerEmbeddingCustomPathKey, FileSource>
  > = {};
  for (const field of schema.fields) {
    const key = field.key as SpeakerEmbeddingCustomPathKey;
    const fromDetect = key === 'model' ? detectPaths?.model : undefined;
    const scanned = key === 'model' ? scanSidModelPath(files) : '';
    const source = toFsSource(fromDetect) ?? toFsSource(scanned);
    if (source) {
      customConfig[key] = source;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as SpeakerEmbeddingCustomPathKey] == null
  );

  return {
    modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}
