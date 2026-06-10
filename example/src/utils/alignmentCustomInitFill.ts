import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectAlignmentModel,
  type AlignmentCustomPathKey,
} from 'react-native-sherpa-onnx/alignment';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

export type FillAlignmentCustomConfigResult = {
  customConfig: Partial<Record<AlignmentCustomPathKey, FileSource>>;
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

function toFsSource(path: string): FileSource | undefined {
  const trimmed = path.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

export async function fillAlignmentCustomConfigFromModelFolder(
  modelSource: FileSource
): Promise<FillAlignmentCustomConfigResult> {
  const detectResult = await detectAlignmentModel(modelSource, {
    modelType: 'wav2vec2',
  });
  if (!detectResult.success || detectResult.modelType !== 'wav2vec2') {
    throw new Error(
      detectResult.error?.trim() ||
        'Alignment wav2vec2 detection failed for fill helper'
    );
  }

  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);
  const modelPath =
    detectResult.paths?.model?.trim() ||
    findOnnxByTokens(files, ['wav2vec', 'align']) ||
    files.find((file) => file.toLowerCase().endsWith('.onnx')) ||
    '';

  const schema = await getCustomModelPathRequirements('alignment', 'wav2vec2');
  const customConfig: Partial<Record<AlignmentCustomPathKey, FileSource>> = {};
  for (const field of schema.fields) {
    const source = field.key === 'model' ? toFsSource(modelPath) : undefined;
    if (source) {
      customConfig[field.key as AlignmentCustomPathKey] = source;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as AlignmentCustomPathKey] == null
  );

  return { customConfig, missingKeys, modelDir };
}
