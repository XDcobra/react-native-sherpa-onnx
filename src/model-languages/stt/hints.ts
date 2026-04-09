import type { ModelLanguage } from '../types';
import { iso6391HintsFromModelLanguages } from '../normalize';
import { CANARY_LANGUAGES } from './canary';
import { COHERE_TRANSCRIBE_LANGUAGES } from './cohere';
import { DOLPHIN_INFO_LANGUAGES } from './dolphin';
import { FUNASR_MLT_NANO_LANGUAGES, FUNASR_NANO_LANGUAGES } from './funasr';
import { QWEN3_ASR_LANGUAGES } from './qwen3Asr';
import { SENSEVOICE_LANGUAGES } from './sensevoice';
import { WHISPER_LANGUAGES } from './whisper';

const SENSEVOICE_NO_AUTO = new Set(['auto']);

const FUNASR_COMBINED = [
  ...FUNASR_NANO_LANGUAGES,
  ...FUNASR_MLT_NANO_LANGUAGES,
] as const;

/**
 * `ModelLanguage` rows used to derive both public ISO-style hints and `modelOptions` ids for STT.
 * Moonshine kinds are omitted (synthetic `en` hint only).
 */
export function sttModelLanguagesForModelType(
  modelType: string | undefined
): readonly ModelLanguage[] | undefined {
  if (!modelType) {
    return undefined;
  }
  switch (modelType) {
    case 'whisper':
      return WHISPER_LANGUAGES;
    case 'sense_voice':
      return SENSEVOICE_LANGUAGES;
    case 'canary':
      return CANARY_LANGUAGES;
    case 'funasr_nano':
      return FUNASR_COMBINED;
    case 'qwen3_asr':
      return QWEN3_ASR_LANGUAGES;
    case 'cohere_transcribe':
      return COHERE_TRANSCRIBE_LANGUAGES;
    case 'dolphin':
      return DOLPHIN_INFO_LANGUAGES;
    default:
      return undefined;
  }
}

/**
 * Map a normalized public hint (e.g. `zh`) to the **`ModelLanguage.id`** value expected in
 * **`modelOptions`** for this STT kind (e.g. Fun-ASR `中文`). Falls back to `publicHint` when
 * no row matches or the kind has no curated list (e.g. Moonshine).
 */
export function sttModelOptionIdForPublicHint(
  modelType: string | undefined,
  publicHint: string
): string {
  if (modelType === 'moonshine' || modelType === 'moonshine_v2') {
    return publicHint;
  }
  const entries = sttModelLanguagesForModelType(modelType);
  if (!entries?.length) {
    return publicHint;
  }
  const exclude = modelType === 'sense_voice' ? SENSEVOICE_NO_AUTO : undefined;
  for (const e of entries) {
    if (exclude?.has(e.id)) {
      continue;
    }
    const rowHints = iso6391HintsFromModelLanguages(
      [e],
      exclude ? { excludeIds: exclude } : undefined
    );
    if (rowHints.includes(publicHint)) {
      return e.id;
    }
  }
  return publicHint;
}

/**
 * Curated ISO-639-1–style primary tags for `detectSttModel().languages` when the filename
 * gives no hints. Moonshine / Moonshine v2 default to `en` as a coarse UI hint.
 */
export function iso6391HintsForSttModelType(
  modelType: string | undefined
): string[] | undefined {
  if (!modelType) {
    return undefined;
  }
  if (modelType === 'moonshine' || modelType === 'moonshine_v2') {
    return ['en'];
  }
  const entries = sttModelLanguagesForModelType(modelType);
  if (!entries) {
    return undefined;
  }
  if (modelType === 'sense_voice') {
    return iso6391HintsFromModelLanguages(entries, {
      excludeIds: SENSEVOICE_NO_AUTO,
    });
  }
  return iso6391HintsFromModelLanguages(entries);
}
