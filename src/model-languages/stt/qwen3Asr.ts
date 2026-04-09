import type { ModelLanguage } from '../types';

/**
 * Display hints only — SttQwen3AsrModelOptions has no language field in this SDK.
 * https://huggingface.co/Qwen/Qwen3-ASR-0.6B#released-models-description-and-download
 */
export const QWEN3_ASR_LANGUAGES: readonly ModelLanguage[] = [
  { id: 'zh', name: 'chinese' },
  { id: 'en', name: 'english' },
  { id: 'yue', name: 'cantonese' },
  { id: 'ar', name: 'arabic' },
  { id: 'de', name: 'german' },
  { id: 'fr', name: 'french' },
  { id: 'es', name: 'spanish' },
  { id: 'pt', name: 'portuguese' },
  { id: 'id', name: 'indonesian' },
  { id: 'it', name: 'italian' },
  { id: 'ko', name: 'korean' },
  { id: 'ru', name: 'russian' },
  { id: 'th', name: 'thai' },
  { id: 'vi', name: 'vietnamese' },
  { id: 'ja', name: 'japanese' },
  { id: 'tr', name: 'turkish' },
  { id: 'hi', name: 'hindi' },
  { id: 'ms', name: 'malay' },
  { id: 'nl', name: 'dutch' },
  { id: 'sv', name: 'swedish' },
  { id: 'da', name: 'danish' },
  { id: 'fi', name: 'finnish' },
  { id: 'pl', name: 'polish' },
  { id: 'cs', name: 'czech' },
  { id: 'fil', name: 'filipino' },
  { id: 'fa', name: 'persian' },
  { id: 'el', name: 'greek' },
  { id: 'hu', name: 'hungarian' },
  { id: 'mk', name: 'macedonian' },
  { id: 'ro', name: 'romanian' },
] as const;

export function getQwen3AsrLanguages(): readonly ModelLanguage[] {
  return QWEN3_ASR_LANGUAGES;
}
