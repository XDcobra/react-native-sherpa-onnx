import type { ModelLanguage } from '../types';

/**
 * Cohere Transcribe: ids are values passed to model.transcribe(..., language="en").
 * https://docs.cohere.com/reference/transcribe
 */
export const COHERE_TRANSCRIBE_LANGUAGES: readonly ModelLanguage[] = [
  { id: 'en', name: 'english' },
  { id: 'fr', name: 'french' },
  { id: 'de', name: 'german' },
  { id: 'it', name: 'italian' },
  { id: 'es', name: 'spanish' },
  { id: 'pt', name: 'portuguese' },
  { id: 'el', name: 'greek' },
  { id: 'nl', name: 'dutch' },
  { id: 'pl', name: 'polish' },
  { id: 'zh', name: 'chinese' },
  { id: 'ja', name: 'japanese' },
  { id: 'ko', name: 'korean' },
  { id: 'vi', name: 'vietnamese' },
  { id: 'ar', name: 'arabic' },
] as const;

export function getCohereTranscribeLanguages(): readonly ModelLanguage[] {
  return COHERE_TRANSCRIBE_LANGUAGES;
}
