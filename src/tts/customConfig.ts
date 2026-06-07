import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import type { TTSConcreteModelType } from './types';

export const TtsErrorCode = {
  INVALID_ARGUMENT: 'TTS_INVALID_ARGUMENT',
} as const;

export type TtsCustomPathKey =
  | 'ttsModel'
  | 'tokens'
  | 'lexicon'
  | 'dataDir'
  | 'voices'
  | 'acousticModel'
  | 'vocoder'
  | 'encoder'
  | 'decoder'
  | 'lmFlow'
  | 'lmMain'
  | 'textConditioner'
  | 'vocabJson'
  | 'tokenScoresJson'
  | 'durationPredictor'
  | 'textEncoder'
  | 'vectorEstimator'
  | 'ttsJson'
  | 'unicodeIndexer'
  | 'voiceStyle';

export interface TtsVitsCustomConfig {
  ttsModel: FileSource;
  tokens: FileSource;
  dataDir?: FileSource;
  lexicon?: FileSource;
}

export interface TtsMatchaCustomConfig {
  acousticModel: FileSource;
  vocoder: FileSource;
  tokens: FileSource;
  dataDir?: FileSource;
  lexicon?: FileSource;
}

export interface TtsKokoroCustomConfig {
  ttsModel: FileSource;
  tokens: FileSource;
  voices: FileSource;
  dataDir: FileSource;
  lexicon?: FileSource;
}

export interface TtsPocketCustomConfig {
  lmFlow: FileSource;
  lmMain: FileSource;
  encoder: FileSource;
  decoder: FileSource;
  textConditioner: FileSource;
  vocabJson: FileSource;
  tokenScoresJson: FileSource;
}

export interface TtsZipvoiceCustomConfig {
  encoder: FileSource;
  decoder: FileSource;
  vocoder: FileSource;
  tokens: FileSource;
  dataDir: FileSource;
  lexicon: FileSource;
}

export interface TtsSupertonicCustomConfig {
  durationPredictor: FileSource;
  textEncoder: FileSource;
  vectorEstimator: FileSource;
  vocoder: FileSource;
  ttsJson: FileSource;
  unicodeIndexer: FileSource;
  voiceStyle: FileSource;
}

export type TtsCustomConfigByModelType = {
  vits: TtsVitsCustomConfig;
  matcha: TtsMatchaCustomConfig;
  kokoro: TtsKokoroCustomConfig;
  kitten: TtsKokoroCustomConfig;
  pocket: TtsPocketCustomConfig;
  zipvoice: TtsZipvoiceCustomConfig;
  supertonic: TtsSupertonicCustomConfig;
};

export type TtsCustomConfig = TtsCustomConfigByModelType[TTSConcreteModelType];

export function assertTtsCustomConfig(
  customConfig: Record<string, unknown>
): void {
  assertCustomModelConfig(customConfig, TtsErrorCode.INVALID_ARGUMENT);
}

export async function resolveTtsCustomConfigPaths(
  modelType: TTSConcreteModelType,
  customConfig: TtsCustomConfig
): Promise<Record<string, string>> {
  return resolveCustomModelConfigPaths({
    category: ModelCategory.Tts,
    modelType,
    customConfig: customConfig as unknown as Record<string, unknown>,
    errorCode: TtsErrorCode.INVALID_ARGUMENT,
    unknownKeyMessage: (key, mt) =>
      `Unknown customConfig key '${key}' for TTS modelType '${mt}'`,
  });
}
