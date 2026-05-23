import type { TTSModelType } from './types';
import type { TtsLexiconLanguage } from '../types/modelDetect';

/**
 * TTS language mechanisms (compact reference for app/UI code).
 *
 * - **`lexiconLanguageId` (init):** selects which `lexicon-*.txt` is loaded (vits, matcha, kokoro,
 *   zipvoice). Re-init to change.
 * - **`modelOptions.kokoro.lang` (init):** Kokoro-only. Not lexicon, not eSpeak `data_dir`.
 * - **`synthesize({ lang })` (runtime):** `extra["lang"]`. Effective: kokoro and supertonic only.
 * - **Detect `languages`:** catalog/name hints for UI — not an engine switch.
 *
 * eSpeak (`espeak-ng-data` / `data_dir`) is configured at init; vits/kitten do not honor runtime `lang`.
 */

export type TtsLanguageMechanism =
  | 'lexiconReinit'
  | 'kokoroInitLang'
  | 'synthesisLang';

const LEXICON_MODEL_TYPES: ReadonlySet<TTSModelType> = new Set([
  'vits',
  'matcha',
  'kokoro',
  'zipvoice',
]);

const SYNTHESIS_LANG_MODEL_TYPES: ReadonlySet<TTSModelType> = new Set([
  'kokoro',
  'supertonic',
]);

/** Init can select a lexicon file by id (vits, matcha, kokoro, zipvoice). */
export function supportsLexiconLanguageId(
  modelType: TTSModelType | undefined
): boolean {
  return (
    modelType != null &&
    modelType !== 'auto' &&
    LEXICON_MODEL_TYPES.has(modelType)
  );
}

/** Init `modelOptions.kokoro.lang` is wired in native config (kokoro only). */
export function supportsKokoroInitLang(
  modelType: TTSModelType | undefined
): boolean {
  return modelType === 'kokoro';
}

/**
 * `synthesize({ lang })` is honored by sherpa-onnx (not merely forwarded) for kokoro and supertonic.
 * Other types may still accept the option in the SDK, but upstream ignores it.
 */
export function supportsSynthesisLang(
  modelType: TTSModelType | undefined
): boolean {
  return (
    modelType != null &&
    modelType !== 'auto' &&
    SYNTHESIS_LANG_MODEL_TYPES.has(modelType)
  );
}

/** True when `synthesize({ lang })` is passed through but upstream documents no effect. */
export function synthesisLangIgnoredByUpstream(
  modelType: TTSModelType | undefined
): boolean {
  return (
    modelType === 'vits' || modelType === 'matcha' || modelType === 'kitten'
  );
}

/**
 * Kokoro: runtime `lang` does not load a different `lexicon-*.txt` (Chinese segments use the
 * lexicon table from init). Prefer `lexiconLanguageId` + re-init for full lexicon-file language changes.
 */
export const runtimeLangDoesNotReplaceLexiconFile = true as const;

export function resolveTtsLanguageMechanisms(
  modelType: TTSModelType | undefined,
  opts?: { hasLexiconLanguages?: boolean }
): TtsLanguageMechanism[] {
  const mechanisms: TtsLanguageMechanism[] = [];
  if (
    supportsLexiconLanguageId(modelType) &&
    opts?.hasLexiconLanguages !== false
  ) {
    mechanisms.push('lexiconReinit');
  }
  if (supportsKokoroInitLang(modelType)) {
    mechanisms.push('kokoroInitLang');
  }
  if (supportsSynthesisLang(modelType)) {
    mechanisms.push('synthesisLang');
  }
  return mechanisms;
}

export function resolveLexiconPath(
  lexiconLanguages: ReadonlyArray<TtsLexiconLanguage> | undefined,
  lexiconLanguageId?: string
): string | undefined {
  if (!lexiconLanguages?.length) return undefined;
  if (lexiconLanguageId != null && lexiconLanguageId.length > 0) {
    return lexiconLanguages.find((l) => l.id === lexiconLanguageId)?.path;
  }
  return lexiconLanguages[0]?.path;
}

const SUPERTONIC_SYNTHESIS_LANG_CODES = ['en', 'ko', 'es', 'pt', 'fr'] as const;

export type TtsLanguagePolicy = {
  mechanisms: TtsLanguageMechanism[];
  lexiconLanguages: ReadonlyArray<TtsLexiconLanguage>;
  synthesisLangCodes?: ReadonlyArray<
    (typeof SUPERTONIC_SYNTHESIS_LANG_CODES)[number]
  >;
  runtimeLangDoesNotReplaceLexiconFile: boolean;
  synthesisLangIgnored: boolean;
};

export function resolveTtsLanguagePolicy(
  modelType: TTSModelType | undefined,
  detection?: { lexiconLanguages?: ReadonlyArray<TtsLexiconLanguage> }
): TtsLanguagePolicy {
  const lexiconLanguages = detection?.lexiconLanguages ?? [];
  return {
    mechanisms: resolveTtsLanguageMechanisms(modelType, {
      hasLexiconLanguages: lexiconLanguages.length > 0,
    }),
    lexiconLanguages,
    synthesisLangCodes:
      modelType === 'supertonic' ? SUPERTONIC_SYNTHESIS_LANG_CODES : undefined,
    runtimeLangDoesNotReplaceLexiconFile: modelType === 'kokoro',
    synthesisLangIgnored: synthesisLangIgnoredByUpstream(modelType),
  };
}
