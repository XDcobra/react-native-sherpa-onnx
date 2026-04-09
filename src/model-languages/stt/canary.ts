import type { ModelLanguage } from '../types';

// Used for modelOptions.canary.srcLang / tgtLang. 180m Canary: 4 langs; 1b: more (see NVIDIA model card).

export const CANARY_LANGUAGES: readonly ModelLanguage[] = [
  { id: 'en', name: 'english' },
  { id: 'es', name: 'spanish' },
  { id: 'de', name: 'german' },
  { id: 'fr', name: 'french' },
] as const;

export function getCanaryLanguages(): readonly ModelLanguage[] {
  return CANARY_LANGUAGES;
}
