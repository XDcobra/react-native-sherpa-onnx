import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectPunctuationModel,
  type OfflinePunctuationCustomPathKey,
  type StreamingPunctuationCustomPathKey,
} from 'react-native-sherpa-onnx/punctuation';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

export type FillOfflinePunctuationCustomConfigResult = {
  customConfig: Partial<Record<OfflinePunctuationCustomPathKey, FileSource>>;
  missingKeys: readonly string[];
  modelDir: string;
};

export type FillStreamingPunctuationCustomConfigResult = {
  customConfig: Partial<Record<StreamingPunctuationCustomPathKey, FileSource>>;
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

function findVocabFile(files: string[]): string {
  const vocabCandidates = files.filter((file) => {
    const lower = basename(file).toLowerCase();
    return lower.endsWith('.vocab') || lower.includes('bpe');
  });
  return vocabCandidates[0] ?? '';
}

function toFsSource(path: string): FileSource | undefined {
  const trimmed = path.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

export async function fillOfflinePunctuationCustomConfigFromModelFolder(
  modelSource: FileSource
): Promise<FillOfflinePunctuationCustomConfigResult> {
  const detectResult = await detectPunctuationModel(modelSource, {
    modelType: 'ct_transformer',
  });
  if (!detectResult.success || detectResult.modelType !== 'ct_transformer') {
    throw new Error(
      detectResult.error?.trim() ||
        'Offline CT-Transformer detection failed for fill helper'
    );
  }

  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);
  const ctPath =
    detectResult.paths?.ct_transformer?.trim() ||
    findOnnxByTokens(files, ['ct', 'punct', 'transformer']) ||
    files.find((file) => file.toLowerCase().endsWith('.onnx')) ||
    '';

  const schema = await getCustomModelPathRequirements(
    'punctuation',
    'ct_transformer'
  );
  const customConfig: Partial<
    Record<OfflinePunctuationCustomPathKey, FileSource>
  > = {};
  for (const key of [...schema.required, ...schema.optional]) {
    const source = key === 'ct_transformer' ? toFsSource(ctPath) : undefined;
    if (source) {
      customConfig[key as OfflinePunctuationCustomPathKey] = source;
    }
  }

  const missingKeys = schema.required.filter(
    (key) => customConfig[key as OfflinePunctuationCustomPathKey] == null
  );

  return { customConfig, missingKeys, modelDir };
}

export async function fillStreamingPunctuationCustomConfigFromModelFolder(
  modelSource: FileSource
): Promise<FillStreamingPunctuationCustomConfigResult> {
  const detectResult = await detectPunctuationModel(modelSource, {
    modelType: 'cnn_bilstm',
  });
  if (
    !detectResult.success ||
    detectResult.modelType !== 'cnn_bilstm' ||
    !detectResult.isStreaming
  ) {
    throw new Error(
      detectResult.error?.trim() ||
        'Streaming CNN-BiLSTM detection failed for fill helper'
    );
  }

  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);
  const cnnPath =
    detectResult.paths?.cnn_bilstm?.trim() ||
    findOnnxByTokens(files, ['cnn', 'bilstm', 'punct']) ||
    '';
  const vocabPath =
    detectResult.paths?.bpe_vocab?.trim() || findVocabFile(files) || '';

  const schema = await getCustomModelPathRequirements(
    'punctuation',
    'cnn_bilstm'
  );
  const customConfig: Partial<
    Record<StreamingPunctuationCustomPathKey, FileSource>
  > = {};
  for (const key of [...schema.required, ...schema.optional]) {
    let source: FileSource | undefined;
    if (key === 'cnn_bilstm') {
      source = toFsSource(cnnPath);
    } else if (key === 'bpe_vocab') {
      source = toFsSource(vocabPath);
    }
    if (source) {
      customConfig[key as StreamingPunctuationCustomPathKey] = source;
    }
  }

  const missingKeys = schema.required.filter(
    (key) => customConfig[key as StreamingPunctuationCustomPathKey] == null
  );

  return { customConfig, missingKeys, modelDir };
}
