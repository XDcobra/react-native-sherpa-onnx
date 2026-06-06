import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import type {
  OnlineSTTModelType,
  StreamingSttCustomPathKey,
} from 'react-native-sherpa-onnx/stt';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

export type FillStreamingCustomConfigResult = {
  modelType: OnlineSTTModelType;
  customConfig: Partial<Record<StreamingSttCustomPathKey, FileSource>>;
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

function findOnnxByToken(files: string[], token: string): string {
  const lowerToken = token.toLowerCase();
  return (
    files.find((file) => {
      const name = basename(file).toLowerCase();
      return name.endsWith('.onnx') && name.includes(lowerToken);
    }) ?? ''
  );
}

function findTokens(files: string[]): string {
  return files.find((file) => basename(file) === 'tokens.txt') ?? '';
}

function scanOnlinePaths(
  files: string[],
  modelType: OnlineSTTModelType
): Partial<Record<StreamingSttCustomPathKey, string>> {
  const tokens = findTokens(files);
  switch (modelType) {
    case 'transducer':
    case 'nemo_transducer':
      return {
        encoder: findOnnxByToken(files, 'encoder'),
        decoder: findOnnxByToken(files, 'decoder'),
        joiner: findOnnxByToken(files, 'joiner'),
        tokens,
      };
    case 'paraformer':
      return {
        encoder: findOnnxByToken(files, 'encoder'),
        decoder: findOnnxByToken(files, 'decoder'),
        tokens,
      };
    case 'zipformer2_ctc':
    case 'nemo_ctc':
    case 'tone_ctc':
    case 'wenet_ctc':
      return {
        model: findOnnxByToken(files, 'model'),
        tokens,
      };
    default:
      return {};
  }
}

function toFileSource(path: string): FileSource {
  return { kind: 'fs', path };
}

export async function fillStreamingCustomConfigFromFolder(args: {
  modelSource: FileSource;
  modelType: OnlineSTTModelType;
}): Promise<FillStreamingCustomConfigResult> {
  const modelDir = await resolveFileSourceForModelInit(args.modelSource);
  const files = await listFilesRecursive(modelDir);
  const scanned = scanOnlinePaths(files, args.modelType);
  const schema = await getCustomModelPathRequirements(
    'stt_streaming',
    args.modelType
  );

  const customConfig: Partial<Record<StreamingSttCustomPathKey, FileSource>> =
    {};
  for (const field of schema.fields) {
    const path = scanned[field.key as StreamingSttCustomPathKey];
    if (path) {
      customConfig[field.key as StreamingSttCustomPathKey] = toFileSource(path);
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as StreamingSttCustomPathKey] == null
  );

  return {
    modelType: args.modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}
