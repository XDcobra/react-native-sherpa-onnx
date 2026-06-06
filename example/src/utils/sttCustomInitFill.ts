/**
 * Example-app helper: scan a model folder and pre-fill customConfig slots.
 * Uses detectSttModel for modelType + filename heuristics aligned with native detection.
 */

import { exists, readDir } from '@dr.pogodin/react-native-fs';
import {
  getCustomModelPathRequirements,
  requiredCustomModelPathFieldKeys,
  resolveFileSourceForModelInit,
} from 'react-native-sherpa-onnx/detect';
import {
  detectSttModel,
  type STTConcreteModelType,
  type SttCustomPathKey,
} from 'react-native-sherpa-onnx/stt';
import type { FileSource } from 'react-native-sherpa-onnx/fileio';

type CandidatePaths = {
  encoder: string;
  decoder: string;
  joiner: string;
  paraformerModel: string;
  ctcModel: string;
  tokens: string;
  funasrEncoderAdaptor: string;
  funasrLLM: string;
  funasrEmbedding: string;
  funasrTokenizer: string;
  qwen3ConvFrontend: string;
  qwen3Encoder: string;
  qwen3Decoder: string;
  qwen3Tokenizer: string;
  moonshinePreprocessor: string;
  moonshineEncoder: string;
  moonshineUncachedDecoder: string;
  moonshineCachedDecoder: string;
  moonshineMergedDecoder: string;
  encoderForV2: string;
};

export type FillSttCustomConfigResult = {
  modelType: STTConcreteModelType;
  customConfig: Partial<Record<SttCustomPathKey, FileSource>>;
  missingKeys: readonly string[];
  modelDir: string;
};

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? path;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const existsDir = await exists(dir);
  if (!existsDir) {
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

function findOnnxByTokens(
  files: string[],
  tokens: string[],
  preferInt8: boolean
): string {
  const onnxFiles = files.filter((file) =>
    file.toLowerCase().endsWith('.onnx')
  );
  const matches = onnxFiles.filter((file) => {
    const lower = basename(file).toLowerCase();
    return tokens.some((token) => lower.includes(token.toLowerCase()));
  });
  if (matches.length === 0) {
    return '';
  }
  if (preferInt8) {
    const int8Match = matches.find((file) => /int8/i.test(basename(file)));
    if (int8Match) {
      return int8Match;
    }
  }
  const nonInt8 = matches.find((file) => !/int8/i.test(basename(file)));
  return nonInt8 ?? matches[0] ?? '';
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

function buildCandidatePaths(
  files: string[],
  preferInt8: boolean
): CandidatePaths {
  return {
    encoder: findOnnxByTokens(files, ['encoder'], preferInt8),
    decoder: findOnnxByTokens(files, ['decoder'], preferInt8),
    joiner: findOnnxByTokens(files, ['joiner'], preferInt8),
    paraformerModel: findOnnxByTokens(files, ['model'], preferInt8),
    ctcModel: findOnnxByTokens(files, ['model', 'ctc'], preferInt8),
    tokens: findFileEndingWith(files, 'tokens.txt'),
    funasrEncoderAdaptor: findOnnxByTokens(
      files,
      ['encoder_adaptor', 'encoder-adaptor'],
      preferInt8
    ),
    funasrLLM: findOnnxByTokens(files, ['llm'], preferInt8),
    funasrEmbedding: findOnnxByTokens(files, ['embedding'], preferInt8),
    funasrTokenizer: findDirByToken(files, 'tokenizer'),
    qwen3ConvFrontend: findOnnxByTokens(
      files,
      ['conv_frontend', 'conv-frontend'],
      preferInt8
    ),
    qwen3Encoder: findOnnxByTokens(files, ['encoder'], preferInt8),
    qwen3Decoder: findOnnxByTokens(files, ['decoder'], preferInt8),
    qwen3Tokenizer: findDirByToken(files, 'tokenizer'),
    moonshinePreprocessor: findOnnxByTokens(
      files,
      ['preprocessor', 'preprocess'],
      preferInt8
    ),
    moonshineEncoder: findOnnxByTokens(
      files,
      ['encode', 'encoder_model', 'encoder'],
      preferInt8
    ),
    moonshineUncachedDecoder: findOnnxByTokens(
      files,
      ['uncached', 'decode'],
      preferInt8
    ),
    moonshineCachedDecoder: findOnnxByTokens(
      files,
      ['cached', 'cache'],
      preferInt8
    ),
    moonshineMergedDecoder: findOnnxByTokens(
      files,
      ['merged', 'decode'],
      preferInt8
    ),
    encoderForV2: findOnnxByTokens(
      files,
      ['encoder', 'encoder_model'],
      preferInt8
    ),
  };
}

function toFsSource(path: string): FileSource | undefined {
  const trimmed = path.trim();
  if (!trimmed) {
    return undefined;
  }
  return { kind: 'fs', path: trimmed };
}

function mapCandidatesToCustomConfig(
  modelType: STTConcreteModelType,
  candidate: CandidatePaths
): Partial<Record<SttCustomPathKey, FileSource>> {
  const out: Partial<Record<SttCustomPathKey, FileSource>> = {};
  const set = (key: SttCustomPathKey, path: string) => {
    const source = toFsSource(path);
    if (source) {
      out[key] = source;
    }
  };

  switch (modelType) {
    case 'transducer':
    case 'nemo_transducer':
      set('encoder', candidate.encoder);
      set('decoder', candidate.decoder);
      set('joiner', candidate.joiner);
      set('tokens', candidate.tokens);
      break;
    case 'paraformer':
      set('tokens', candidate.tokens);
      if (candidate.paraformerModel) {
        set('paraformerModel', candidate.paraformerModel);
      } else {
        set('encoder', candidate.encoder);
        set('decoder', candidate.decoder);
      }
      break;
    case 'nemo_ctc':
    case 'wenet_ctc':
    case 'sense_voice':
    case 'zipformer_ctc':
    case 'ctc':
      set('ctcModel', candidate.ctcModel);
      set('tokens', candidate.tokens);
      break;
    case 'whisper':
      set('whisperEncoder', candidate.encoder);
      set('whisperDecoder', candidate.decoder);
      set('tokens', candidate.tokens);
      break;
    case 'funasr_nano':
      set('funasrEncoderAdaptor', candidate.funasrEncoderAdaptor);
      set('funasrLLM', candidate.funasrLLM);
      set('funasrEmbedding', candidate.funasrEmbedding);
      set('funasrTokenizer', candidate.funasrTokenizer);
      break;
    case 'qwen3_asr':
      set('qwen3ConvFrontend', candidate.qwen3ConvFrontend);
      set('qwen3Encoder', candidate.qwen3Encoder);
      set('qwen3Decoder', candidate.qwen3Decoder);
      set('qwen3Tokenizer', candidate.qwen3Tokenizer);
      break;
    case 'cohere_transcribe':
      set('cohereEncoder', candidate.encoder);
      set('cohereDecoder', candidate.decoder);
      set('tokens', candidate.tokens);
      break;
    case 'moonshine':
      if (candidate.moonshineMergedDecoder) {
        set('moonshineEncoder', candidate.encoderForV2);
        set('moonshineUncachedDecoder', candidate.moonshineMergedDecoder);
        set('moonshineCachedDecoder', candidate.moonshineMergedDecoder);
        set('moonshinePreprocessor', candidate.moonshinePreprocessor);
      } else {
        set('moonshinePreprocessor', candidate.moonshinePreprocessor);
        set('moonshineEncoder', candidate.moonshineEncoder);
        set('moonshineUncachedDecoder', candidate.moonshineUncachedDecoder);
        set('moonshineCachedDecoder', candidate.moonshineCachedDecoder);
      }
      set('tokens', candidate.tokens);
      break;
    case 'fire_red_asr': {
      const single =
        candidate.paraformerModel || candidate.ctcModel || candidate.encoder;
      set('fireRedEncoder', candidate.encoder || single);
      set('fireRedDecoder', candidate.decoder || single);
      set('tokens', candidate.tokens);
      break;
    }
    case 'dolphin':
      set(
        'dolphinModel',
        candidate.ctcModel || candidate.paraformerModel || candidate.ctcModel
      );
      set('tokens', candidate.tokens);
      break;
    case 'canary':
      set('canaryEncoder', candidate.encoder);
      set('canaryDecoder', candidate.decoder);
      set('tokens', candidate.tokens);
      break;
    case 'omnilingual':
      set('omnilingualModel', candidate.ctcModel);
      set('tokens', candidate.tokens);
      break;
    case 'medasr':
      set('medasrModel', candidate.ctcModel);
      set('tokens', candidate.tokens);
      break;
    case 'telespeech_ctc':
      set('telespeechCtcModel', candidate.ctcModel);
      set('tokens', candidate.tokens);
      break;
    default:
      break;
  }

  return out;
}

function isConcreteSttModelType(value: string): value is STTConcreteModelType {
  return value !== 'auto';
}

export async function fillSttCustomConfigFromModelFolder(
  modelSource: FileSource,
  options?: {
    preferInt8?: boolean;
    modelTypeOverride?: STTConcreteModelType;
  }
): Promise<FillSttCustomConfigResult> {
  const preferInt8 = options?.preferInt8 ?? true;
  const detectResult = await detectSttModel(modelSource, {
    preferInt8,
    modelType: options?.modelTypeOverride,
  });
  if (!detectResult.success) {
    throw new Error(
      detectResult.error?.trim() || 'Model detection failed for fill helper'
    );
  }

  const rawType =
    options?.modelTypeOverride ??
    (detectResult.modelType && isConcreteSttModelType(detectResult.modelType)
      ? detectResult.modelType
      : detectResult.detectedModels[0]?.type);

  if (!rawType || !isConcreteSttModelType(rawType)) {
    throw new Error('Could not determine a concrete STT model type for fill');
  }

  const modelType = rawType;
  const modelDir = await resolveFileSourceForModelInit(modelSource);
  const files = await listFilesRecursive(modelDir);
  const candidate = buildCandidatePaths(files, preferInt8);
  const customConfig = mapCandidatesToCustomConfig(modelType, candidate);

  const missingKeys = requiredCustomModelPathFieldKeys(
    await getCustomModelPathRequirements('stt', modelType)
  ).filter(
    (key) =>
      (customConfig as Record<string, FileSource | undefined>)[key] == null
  );

  return {
    modelType,
    customConfig,
    missingKeys,
    modelDir,
  };
}
