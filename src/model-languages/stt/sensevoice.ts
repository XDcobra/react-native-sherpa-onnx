import type { ModelLanguage } from '../types';

// https://github.com/FunAudioLLM/SenseVoice/blob/1a90d46cb933ef9e213b7d90292b9301b3e20f40/api.py#L22

export const SENSEVOICE_LANGUAGES: readonly ModelLanguage[] = [
  { id: 'auto', name: 'auto' },
  { id: 'zh', name: 'chinese' },
  { id: 'en', name: 'english' },
  { id: 'yue', name: 'cantonese' },
  { id: 'ja', name: 'japanese' },
  { id: 'ko', name: 'korean' },
] as const;

export function getSenseVoiceLanguages(): readonly ModelLanguage[] {
  return SENSEVOICE_LANGUAGES;
}
