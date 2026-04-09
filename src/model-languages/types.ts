/**
 * Language or option value (`id`) plus an English `name` for UI (e.g. dropdown labels).
 * `id` is whatever the native stack expects (e.g. Whisper `"en"`, FunASR `"中文"`).
 */
export type ModelLanguage = {
  id: string;
  name: string;
};
