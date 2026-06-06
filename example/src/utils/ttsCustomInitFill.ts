import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectTtsModel,
  type TTSConcreteModelType,
  type TtsCustomPathKey,
} from 'react-native-sherpa-onnx/tts';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

export type FillTtsCustomConfigResult = {
  modelType: TTSConcreteModelType;
  customConfig: Partial<Record<TtsCustomPathKey, FileSource>>;
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

function findFileEndingWith(files: string[], suffix: string): string {
  const lowerSuffix = suffix.toLowerCase();
  return files.find((file) => file.toLowerCase().endsWith(lowerSuffix)) ?? '';
}

function findDirByToken(files: string[], token: string): string {
  const dirs = new Set<string>();
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    const idx = normalized.toLowerCase().indexOf(`/${token.toLowerCase()}/`);
    if (idx >= 0) {
      dirs.add(normalized.slice(0, idx + token.length + 1));
    }
  }
  return dirs.values().next().value ?? '';
}

function scanTtsPaths(
  files: string[],
  modelType: TTSConcreteModelType
): Partial<Record<TtsCustomPathKey, string>> {
  const tokens = findFileEndingWith(files, 'tokens.txt');
  switch (modelType) {
    case 'vits':
      return {
        ttsModel:
          findOnnxByTokens(files, ['vits', 'model']) ||
          findOnnxByTokens(files, ['model']),
        tokens,
        dataDir: findDirByToken(files, 'espeak-ng-data'),
        lexicon: findFileEndingWith(files, 'lexicon.txt'),
      };
    case 'matcha':
      return {
        acousticModel: findOnnxByTokens(files, ['acoustic', 'model']),
        vocoder: findOnnxByTokens(files, ['vocoder', 'vocos']),
        tokens,
        dataDir: findDirByToken(files, 'espeak-ng-data'),
        lexicon: findFileEndingWith(files, 'lexicon.txt'),
      };
    case 'kokoro':
    case 'kitten':
      return {
        ttsModel: findOnnxByTokens(files, ['model', 'kokoro', 'kitten']),
        tokens,
        voices:
          findFileEndingWith(files, 'voices.bin') ||
          findFileEndingWith(files, 'voices.pt'),
        dataDir: findDirByToken(files, 'espeak-ng-data'),
        lexicon: findFileEndingWith(files, 'lexicon.txt'),
      };
    case 'pocket':
      return {
        lmFlow: findOnnxByTokens(files, ['lm_flow', 'lm-flow', 'flow']),
        lmMain: findOnnxByTokens(files, ['lm_main', 'lm-main', 'main']),
        encoder: findOnnxByTokens(files, ['encoder']),
        decoder: findOnnxByTokens(files, ['decoder']),
        textConditioner: findOnnxByTokens(files, [
          'text_conditioner',
          'text-conditioner',
          'conditioner',
        ]),
        vocabJson: findFileEndingWith(files, 'vocab.json'),
        tokenScoresJson: findFileEndingWith(files, 'token_scores.json'),
      };
    case 'zipvoice':
      return {
        encoder: findOnnxByTokens(files, ['encoder']),
        decoder: findOnnxByTokens(files, ['decoder']),
        vocoder: findOnnxByTokens(files, ['vocoder', 'vocos']),
        tokens,
        dataDir: findDirByToken(files, 'espeak-ng-data'),
        lexicon: findFileEndingWith(files, 'lexicon.txt'),
      };
    case 'supertonic':
      return {
        durationPredictor: findOnnxByTokens(files, [
          'duration',
          'duration_predictor',
        ]),
        textEncoder: findOnnxByTokens(files, ['text_encoder', 'text-encoder']),
        vectorEstimator: findOnnxByTokens(files, [
          'vector_estimator',
          'vector-estimator',
        ]),
        vocoder: findOnnxByTokens(files, ['vocoder']),
        ttsJson: findFileEndingWith(files, 'tts.json'),
        unicodeIndexer: findFileEndingWith(files, 'unicode_indexer.txt'),
        voiceStyle: findFileEndingWith(files, 'voice_style.bin'),
      };
    default:
      return {};
  }
}

function toFsSource(path: string): FileSource | undefined {
  const trimmed = path.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

function isConcreteTtsModelType(value: string): value is TTSConcreteModelType {
  return value !== 'auto';
}

export async function fillTtsCustomConfigFromModelFolder(
  modelSource: FileSource,
  options?: { modelTypeOverride?: TTSConcreteModelType }
): Promise<FillTtsCustomConfigResult> {
  const detectResult = await detectTtsModel(modelSource, {
    modelType: options?.modelTypeOverride,
  });
  if (!detectResult.success) {
    throw new Error(
      detectResult.error?.trim() || 'Model detection failed for fill helper'
    );
  }

  const rawType =
    options?.modelTypeOverride ??
    (detectResult.modelType && isConcreteTtsModelType(detectResult.modelType)
      ? detectResult.modelType
      : detectResult.detectedModels[0]?.type);

  if (!rawType || !isConcreteTtsModelType(rawType)) {
    throw new Error('Could not determine a concrete TTS model type for fill');
  }

  const modelType = rawType;
  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);
  const scanned = scanTtsPaths(files, modelType);

  const schema = await getCustomModelPathRequirements('tts', modelType);
  const customConfig: Partial<Record<TtsCustomPathKey, FileSource>> = {};
  for (const field of schema.fields) {
    const path = scanned[field.key as TtsCustomPathKey];
    const source = path ? toFsSource(path) : undefined;
    if (source) {
      customConfig[field.key as TtsCustomPathKey] = source;
    }
  }

  const missingKeys = requiredCustomModelPathFieldKeys(schema).filter(
    (key) => customConfig[key as TtsCustomPathKey] == null
  );

  return {
    modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}
