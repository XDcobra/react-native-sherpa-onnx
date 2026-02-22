/**
 * Whisper language codes and display names.
 * Matches the language list supported by sherpa-onnx Whisper models.
 * Use these codes for the `language` hint in SttWhisperModelOptions to avoid crashes from invalid codes.
 */

export interface WhisperLanguage {
  /** ISO-style language code (e.g. "en", "de"). Use this as modelOptions.whisper.language. */
  id: string;
  /** Display name for the language (e.g. "english", "german"). */
  name: string;
}

/** Ordered list of all Whisper-supported language codes and names. */
export const WHISPER_LANGUAGES: readonly WhisperLanguage[] = [
  { id: 'en', name: 'english' },
  { id: 'zh', name: 'chinese' },
  { id: 'de', name: 'german' },
  { id: 'es', name: 'spanish' },
  { id: 'ru', name: 'russian' },
  { id: 'ko', name: 'korean' },
  { id: 'fr', name: 'french' },
  { id: 'ja', name: 'japanese' },
  { id: 'pt', name: 'portuguese' },
  { id: 'tr', name: 'turkish' },
  { id: 'pl', name: 'polish' },
  { id: 'ca', name: 'catalan' },
  { id: 'nl', name: 'dutch' },
  { id: 'ar', name: 'arabic' },
  { id: 'sv', name: 'swedish' },
  { id: 'it', name: 'italian' },
  { id: 'id', name: 'indonesian' },
  { id: 'hi', name: 'hindi' },
  { id: 'fi', name: 'finnish' },
  { id: 'vi', name: 'vietnamese' },
  { id: 'he', name: 'hebrew' },
  { id: 'uk', name: 'ukrainian' },
  { id: 'el', name: 'greek' },
  { id: 'ms', name: 'malay' },
  { id: 'cs', name: 'czech' },
  { id: 'ro', name: 'romanian' },
  { id: 'da', name: 'danish' },
  { id: 'hu', name: 'hungarian' },
  { id: 'ta', name: 'tamil' },
  { id: 'no', name: 'norwegian' },
  { id: 'th', name: 'thai' },
  { id: 'ur', name: 'urdu' },
  { id: 'hr', name: 'croatian' },
  { id: 'bg', name: 'bulgarian' },
  { id: 'lt', name: 'lithuanian' },
  { id: 'la', name: 'latin' },
  { id: 'mi', name: 'maori' },
  { id: 'ml', name: 'malayalam' },
  { id: 'cy', name: 'welsh' },
  { id: 'sk', name: 'slovak' },
  { id: 'te', name: 'telugu' },
  { id: 'fa', name: 'persian' },
  { id: 'lv', name: 'latvian' },
  { id: 'bn', name: 'bengali' },
  { id: 'sr', name: 'serbian' },
  { id: 'az', name: 'azerbaijani' },
  { id: 'sl', name: 'slovenian' },
  { id: 'kn', name: 'kannada' },
  { id: 'et', name: 'estonian' },
  { id: 'mk', name: 'macedonian' },
  { id: 'br', name: 'breton' },
  { id: 'eu', name: 'basque' },
  { id: 'is', name: 'icelandic' },
  { id: 'hy', name: 'armenian' },
  { id: 'ne', name: 'nepali' },
  { id: 'mn', name: 'mongolian' },
  { id: 'bs', name: 'bosnian' },
  { id: 'kk', name: 'kazakh' },
  { id: 'sq', name: 'albanian' },
  { id: 'sw', name: 'swahili' },
  { id: 'gl', name: 'galician' },
  { id: 'mr', name: 'marathi' },
  { id: 'pa', name: 'punjabi' },
  { id: 'si', name: 'sinhala' },
  { id: 'km', name: 'khmer' },
  { id: 'sn', name: 'shona' },
  { id: 'yo', name: 'yoruba' },
  { id: 'so', name: 'somali' },
  { id: 'af', name: 'afrikaans' },
  { id: 'oc', name: 'occitan' },
  { id: 'ka', name: 'georgian' },
  { id: 'be', name: 'belarusian' },
  { id: 'tg', name: 'tajik' },
  { id: 'sd', name: 'sindhi' },
  { id: 'gu', name: 'gujarati' },
  { id: 'am', name: 'amharic' },
  { id: 'yi', name: 'yiddish' },
  { id: 'lo', name: 'lao' },
  { id: 'uz', name: 'uzbek' },
  { id: 'fo', name: 'faroese' },
  { id: 'ht', name: 'haitian creole' },
  { id: 'ps', name: 'pashto' },
  { id: 'tk', name: 'turkmen' },
  { id: 'nn', name: 'nynorsk' },
  { id: 'mt', name: 'maltese' },
  { id: 'sa', name: 'sanskrit' },
  { id: 'lb', name: 'luxembourgish' },
  { id: 'my', name: 'myanmar' },
  { id: 'bo', name: 'tibetan' },
  { id: 'tl', name: 'tagalog' },
  { id: 'mg', name: 'malagasy' },
  { id: 'as', name: 'assamese' },
  { id: 'tt', name: 'tatar' },
  { id: 'haw', name: 'hawaiian' },
  { id: 'ln', name: 'lingala' },
  { id: 'ha', name: 'hausa' },
  { id: 'ba', name: 'bashkir' },
  { id: 'jw', name: 'javanese' },
  { id: 'su', name: 'sundanese' },
  { id: 'yue', name: 'cantonese' },
] as const;

/**
 * Returns the list of Whisper-supported language codes and display names.
 * Use for building a language-hint dropdown so users only pick valid codes (invalid codes can crash the app).
 *
 * @returns Array of { id, name } where id is the language code (e.g. "en") and name is the display name (e.g. "english")
 * @example
 * ```ts
 * import { getWhisperLanguages } from 'react-native-sherpa-onnx/stt';
 * const languages = getWhisperLanguages();
 * // languages[0] => { id: 'en', name: 'english' }
 * ```
 */
export function getWhisperLanguages(): readonly WhisperLanguage[] {
  return WHISPER_LANGUAGES;
}
