import type { FileSource } from '../fileio/types';
import { ModelCategory } from '../download/types';
import {
  assertCustomModelConfig,
  createInvalidArgumentError,
  isFileSource,
  resolveCustomModelConfigPaths,
} from '../detect/customConfigResolver';
import { resolveModelFileSources } from '../detect/resolveModelInput';
import type { TTSConcreteModelType } from './types';

export const TtsErrorCode = {
  INVALID_ARGUMENT: 'TTS_INVALID_ARGUMENT',
} as const;

export type TtsCustomPathKey =
  | 'ttsModel'
  | 'tokens'
  | 'lexicon'
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
  lexicon?: FileSource;
}

export interface TtsMatchaCustomConfig {
  acousticModel: FileSource;
  vocoder: FileSource;
  tokens: FileSource;
  lexicon?: FileSource;
}

export interface TtsKokoroCustomConfig {
  ttsModel: FileSource;
  tokens: FileSource;
  voices: FileSource;
  lexicon?: FileSource;
}

export interface TtsKittenCustomConfig {
  ttsModel: FileSource;
  tokens: FileSource;
  voices: FileSource;
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
  /**
   * One lexicon or several (all are loaded). ZipVoice skips every word missing
   * from the loaded lexicons, so English text with the zh-en model needs an
   * English lexicon next to the Chinese one, e.g. `[lexiconZh, lexiconEnUs]`.
   */
  lexicon?: FileSource | FileSource[];
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
  kitten: TtsKittenCustomConfig;
  pocket: TtsPocketCustomConfig;
  zipvoice: TtsZipvoiceCustomConfig;
  supertonic: TtsSupertonicCustomConfig;
};

export type TtsCustomConfig = TtsCustomConfigByModelType[TTSConcreteModelType];

/**
 * Structural check: every present customConfig value must be a FileSource.
 * @throws {Error} `TTS_INVALID_ARGUMENT` — a customConfig value is not a FileSource.
 */
export function assertTtsCustomConfig(
  customConfig: Record<string, unknown>
): void {
  const { lexicon, ...rest } = customConfig;
  if (Array.isArray(lexicon)) {
    assertLexiconList(lexicon);
    assertCustomModelConfig(rest, TtsErrorCode.INVALID_ARGUMENT);
    return;
  }
  assertCustomModelConfig(customConfig, TtsErrorCode.INVALID_ARGUMENT);
}

function assertLexiconList(lexicon: unknown[]): void {
  if (lexicon.length === 0 || !lexicon.every(isFileSource)) {
    createInvalidArgumentError(
      TtsErrorCode.INVALID_ARGUMENT,
      'customConfig.lexicon must be a FileSource or a non-empty array of FileSource objects'
    );
  }
}

/**
 * Resolves `customConfig` to native paths. A `lexicon` array (ZipVoice only) is
 * resolved per entry and joined with ',' — the multi-lexicon form upstream reads.
 *
 * @throws {Error} `TTS_INVALID_ARGUMENT` — invalid or unknown keys, a lexicon array on
 * another model type, or a lexicon path that contains ','.
 */
export async function resolveTtsCustomConfigPaths(
  modelType: TTSConcreteModelType,
  customConfig: TtsCustomConfig
): Promise<Record<string, string>> {
  const { lexicon, ...rest } = customConfig as unknown as Record<
    string,
    unknown
  >;
  if (!Array.isArray(lexicon)) {
    return resolveCustomPaths(modelType, customConfig);
  }
  if (modelType !== 'zipvoice') {
    createInvalidArgumentError(
      TtsErrorCode.INVALID_ARGUMENT,
      `customConfig.lexicon as an array is only supported for zipvoice, not '${modelType}'`
    );
  }
  assertLexiconList(lexicon);
  const [first, ...others] = lexicon as FileSource[];
  const paths = await resolveCustomPaths(modelType, {
    ...rest,
    lexicon: first,
  } as unknown as TtsCustomConfig);
  const lexiconPaths = [paths.lexicon];
  for (const source of others) {
    const resolved = await resolveModelFileSources({ lexicon: source });
    lexiconPaths.push(resolved.lexicon);
  }
  for (const path of lexiconPaths) {
    if (!path || path.includes(',')) {
      createInvalidArgumentError(
        TtsErrorCode.INVALID_ARGUMENT,
        `customConfig.lexicon path must be set and must not contain ',': ${path}`
      );
    }
  }
  return { ...paths, lexicon: lexiconPaths.join(',') };
}

function resolveCustomPaths(
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
