import { normalizePublicLanguageList } from './normalize';
import {
  iso6391HintsForSttModelType,
  sttModelOptionIdForPublicHint,
} from './stt/hints';
import { iso6391HintsForTtsModelType } from './tts/hints';
import { iso6391HintsForAlignmentModelType } from './alignment/hints';
import { ModelCategory } from '../download/types';

export type ResolvePublicLanguageHintsInput = {
  domain: ModelCategory;
  modelType?: string;
  /** Catalog id, archive stem, or on-disk folder basename (e.g. Supertonic 3 disambiguation). */
  modelKey?: string;
  rawFromNative?: readonly string[];
};

/**
 * Normalized **`iso6391Hint`** (catalog / filters) plus **`id`**: the value to pass in
 * **`modelOptions`** when that stack has a language field — usually **`ModelLanguage.id`**
 * from the per-architecture list (`FUNASR_MLT_NANO_LANGUAGES`, …). When they match (e.g. Whisper),
 * **`id`** equals **`iso6391Hint`**. TTS hints currently use **`id === iso6391Hint`**.
 */
export type PublicLanguageHint = {
  iso6391Hint: string;
  id: string;
};

function modelOptionIdForPublicHint(
  input: ResolvePublicLanguageHintsInput,
  iso6391Hint: string
): string {
  if (input.domain === ModelCategory.Stt) {
    return sttModelOptionIdForPublicHint(input.modelType, iso6391Hint);
  }
  return iso6391Hint;
}

function resolvePublicLanguageHintStrings(
  input: ResolvePublicLanguageHintsInput
): string[] {
  const normalized = normalizePublicLanguageList(input.rawFromNative);
  if (normalized.length > 0) {
    return normalized;
  }
  switch (input.domain) {
    case ModelCategory.Tts:
      return iso6391HintsForTtsModelType(input.modelType, input.modelKey) ?? [];
    case ModelCategory.Stt:
      return iso6391HintsForSttModelType(input.modelType) ?? [];
    case ModelCategory.Alignment:
      return iso6391HintsForAlignmentModelType(input.modelType) ?? [];
    case ModelCategory.Vad:
      return [];
    case ModelCategory.Punctuation:
      return [];
    default: {
      return [];
    }
  }
}

/**
 * Single entry point for **public** normalized language hint tags (mostly ISO 639-1 plus
 * documented extensions). Normalizes optional native/folder heuristics first; if empty,
 * applies curated per-domain fallbacks (TTS/STT). Each row adds **`id`** for **`modelOptions`**
 * when applicable (STT kinds with curated lists).
 */
export function resolvePublicLanguageHints(
  input: ResolvePublicLanguageHintsInput
): PublicLanguageHint[] {
  return resolvePublicLanguageHintStrings(input).map((iso6391Hint) => ({
    iso6391Hint,
    id: modelOptionIdForPublicHint(input, iso6391Hint),
  }));
}
