import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  getCustomModelPathRequirements,
  validateCustomModelPaths,
} from '../detect/validateCustomModelPaths';
import type { STTConcreteModelType } from './types';
import { SttErrorCode } from './types';

export type SttCustomPathKey =
  | 'encoder'
  | 'decoder'
  | 'joiner'
  | 'tokens'
  | 'bpeVocab'
  | 'paraformerModel'
  | 'ctcModel'
  | 'whisperEncoder'
  | 'whisperDecoder'
  | 'funasrEncoderAdaptor'
  | 'funasrLLM'
  | 'funasrEmbedding'
  | 'funasrTokenizer'
  | 'qwen3ConvFrontend'
  | 'qwen3Encoder'
  | 'qwen3Decoder'
  | 'qwen3Tokenizer'
  | 'cohereEncoder'
  | 'cohereDecoder'
  | 'moonshinePreprocessor'
  | 'moonshineEncoder'
  | 'moonshineUncachedDecoder'
  | 'moonshineCachedDecoder'
  | 'moonshineMergedDecoder'
  | 'fireRedEncoder'
  | 'fireRedDecoder'
  | 'canaryEncoder'
  | 'canaryDecoder'
  | 'dolphinModel'
  | 'omnilingualModel'
  | 'medasrModel'
  | 'telespeechCtcModel';

type SttCustomConfigBase = Partial<Record<SttCustomPathKey, FileSource>>;

export interface SttTransducerCustomConfig extends SttCustomConfigBase {
  encoder: FileSource;
  decoder: FileSource;
  joiner: FileSource;
  tokens: FileSource;
  bpeVocab?: FileSource;
}

export interface SttParaformerCustomConfig extends SttCustomConfigBase {
  tokens: FileSource;
  paraformerModel?: FileSource;
  encoder?: FileSource;
  decoder?: FileSource;
}

export interface SttCtcCustomConfig extends SttCustomConfigBase {
  ctcModel: FileSource;
  tokens: FileSource;
}

export interface SttWhisperCustomConfig extends SttCustomConfigBase {
  whisperEncoder: FileSource;
  whisperDecoder: FileSource;
  tokens: FileSource;
}

export interface SttFunAsrNanoCustomConfig extends SttCustomConfigBase {
  funasrEncoderAdaptor: FileSource;
  funasrLLM: FileSource;
  funasrEmbedding: FileSource;
  funasrTokenizer: FileSource;
}

export interface SttQwen3AsrCustomConfig extends SttCustomConfigBase {
  qwen3ConvFrontend: FileSource;
  qwen3Encoder: FileSource;
  qwen3Decoder: FileSource;
  qwen3Tokenizer: FileSource;
}

export interface SttCohereTranscribeCustomConfig extends SttCustomConfigBase {
  cohereEncoder: FileSource;
  cohereDecoder: FileSource;
  tokens: FileSource;
}

export interface SttMoonshineCustomConfig extends SttCustomConfigBase {
  moonshinePreprocessor: FileSource;
  moonshineEncoder: FileSource;
  moonshineUncachedDecoder: FileSource;
  moonshineCachedDecoder: FileSource;
  tokens: FileSource;
}

export interface SttMoonshineV2CustomConfig extends SttCustomConfigBase {
  moonshineEncoder: FileSource;
  moonshineMergedDecoder: FileSource;
}

export interface SttFireRedAsrCustomConfig extends SttCustomConfigBase {
  fireRedEncoder: FileSource;
  fireRedDecoder: FileSource;
  tokens: FileSource;
}

export interface SttCanaryCustomConfig extends SttCustomConfigBase {
  canaryEncoder: FileSource;
  canaryDecoder: FileSource;
  tokens: FileSource;
}

export interface SttSingleModelCustomConfig extends SttCustomConfigBase {
  tokens: FileSource;
  dolphinModel?: FileSource;
  omnilingualModel?: FileSource;
  medasrModel?: FileSource;
  telespeechCtcModel?: FileSource;
}

export type SttCustomConfigByModelType = {
  transducer: SttTransducerCustomConfig;
  nemo_transducer: SttTransducerCustomConfig;
  paraformer: SttParaformerCustomConfig;
  nemo_ctc: SttCtcCustomConfig;
  wenet_ctc: SttCtcCustomConfig;
  sense_voice: SttCtcCustomConfig;
  zipformer_ctc: SttCtcCustomConfig;
  ctc: SttCtcCustomConfig;
  tone_ctc: SttCtcCustomConfig;
  whisper: SttWhisperCustomConfig;
  funasr_nano: SttFunAsrNanoCustomConfig;
  qwen3_asr: SttQwen3AsrCustomConfig;
  cohere_transcribe: SttCohereTranscribeCustomConfig;
  fire_red_asr: SttFireRedAsrCustomConfig;
  moonshine: SttMoonshineCustomConfig;
  moonshine_v2: SttMoonshineV2CustomConfig;
  dolphin: SttSingleModelCustomConfig & { dolphinModel: FileSource };
  canary: SttCanaryCustomConfig;
  omnilingual: SttSingleModelCustomConfig & { omnilingualModel: FileSource };
  medasr: SttSingleModelCustomConfig & { medasrModel: FileSource };
  telespeech_ctc: SttSingleModelCustomConfig & {
    telespeechCtcModel: FileSource;
  };
};

export type SttCustomConfig = SttCustomConfigByModelType[STTConcreteModelType];

function createSttInvalidArgumentError(message: string): never {
  const err = new Error(
    `${SttErrorCode.INVALID_ARGUMENT}: ${message}`
  ) as Error & {
    code?: string;
  };
  err.code = SttErrorCode.INVALID_ARGUMENT;
  throw err;
}

function isFileSource(value: unknown): value is FileSource {
  if (typeof value !== 'object' || value === null || !('kind' in value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string';
}

/** Structural check: every present customConfig value must be a FileSource. */
export function assertSttCustomConfig(
  customConfig: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(customConfig)) {
    if (!isFileSource(value)) {
      createSttInvalidArgumentError(
        `customConfig.${key} must be a FileSource object`
      );
    }
  }
}

export async function resolveSttCustomConfigPaths(
  modelType: STTConcreteModelType,
  customConfig: SttCustomConfig
): Promise<Record<string, string>> {
  assertSttCustomConfig(customConfig as unknown as Record<string, unknown>);

  const schema = await getCustomModelPathRequirements(
    ModelCategory.Stt,
    modelType
  );
  const allowedKeys = new Set([...schema.required, ...schema.optional]);
  for (const key of Object.keys(customConfig)) {
    if (!allowedKeys.has(key)) {
      createSttInvalidArgumentError(
        `Unknown customConfig key '${key}' for modelType '${modelType}'`
      );
    }
  }

  const fileSources: Record<string, FileSource> = {};
  for (const [key, value] of Object.entries(customConfig)) {
    if (isFileSource(value)) {
      fileSources[key] = value;
    }
  }
  const { resolveModelFileSources } = await import(
    '../detect/resolveModelInput'
  );
  const resolvedPaths = await resolveModelFileSources(fileSources);

  const validation = await validateCustomModelPaths(
    ModelCategory.Stt,
    modelType,
    resolvedPaths
  );
  if (!validation.ok) {
    createSttInvalidArgumentError(
      validation.error?.trim() ||
        `Missing required paths: ${(validation.missingRequired ?? []).join(
          ', '
        )}`
    );
  }

  return resolvedPaths;
}
