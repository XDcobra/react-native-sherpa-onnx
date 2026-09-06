import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectDiarizationModel,
  type DiarizationCustomPathKey,
  type StreamingDiarizationConcreteModelType,
} from 'react-native-sherpa-onnx/diarization';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

export type FillDiarizationStreamingCustomConfigResult = {
  modelType: StreamingDiarizationConcreteModelType;
  customConfig: Partial<Record<DiarizationCustomPathKey, FileSource>>;
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

function findMetadataJson(files: string[]): string {
  const jsonFiles = files.filter(
    (file) => basename(file).toLowerCase() === 'metadata.json'
  );
  return jsonFiles[0] ?? '';
}

function toFsSource(path: string): FileSource | undefined {
  const trimmed = path.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

export async function fillDiarizationStreamingCustomConfigFromModelFolder(
  modelSource: FileSource
): Promise<FillDiarizationStreamingCustomConfigResult> {
  const detectResult = await detectDiarizationModel(modelSource);
  if (!detectResult.success || !detectResult.isStreaming) {
    throw new Error(
      detectResult.error?.trim() ||
        'Streaming Sortformer diarization detection failed for fill helper'
    );
  }

  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);

  const modelPath =
    detectResult.paths?.model?.trim() ||
    findOnnxByTokens(files, ['sortformer', 'model']) ||
    files.find((file) => file.toLowerCase().endsWith('.onnx')) ||
    '';

  const metadataPath =
    detectResult.paths?.metadata?.trim() || findMetadataJson(files) || '';

  const schema = await getCustomModelPathRequirements(
    'diarization',
    'sortformer'
  );

  const customConfig: Partial<Record<DiarizationCustomPathKey, FileSource>> =
    {};
  for (const field of schema.fields) {
    if (field.key === 'model') {
      const src = toFsSource(modelPath);
      if (src) customConfig.model = src;
    } else if (field.key === 'metadata') {
      const src = toFsSource(metadataPath);
      if (src) customConfig.metadata = src;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as DiarizationCustomPathKey] == null
  );

  return {
    modelType: 'sortformer',
    customConfig,
    missingKeys,
    modelDir,
  };
}
