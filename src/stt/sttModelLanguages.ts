/**
 * STT model language codes and display names.
 * Per-model lists for Whisper, SenseVoice, and others. Use these for language-hint
 * dropdowns so users only pick valid codes (invalid codes can crash the app, e.g. Whisper).
 */

export interface SttModelLanguage {
  /**
   * Value to pass as language (e.g. "en" for Whisper, "中文" for FunASR Nano).
   * Use as modelOptions.<model>.language (or srcLang/tgtLang where applicable).
   */
  id: string;
  /** Display name in English (e.g. "english", "chinese"). */
  name: string;
}

/** @deprecated Use SttModelLanguage. Kept for backward compatibility. */
export type WhisperLanguage = SttModelLanguage;

// ========== Whisper ==========
// https://github.com/ggml-org/whisper.cpp/blob/d682e150908e10caa4c15883c633d7902d385237/src/whisper.cpp#L248

/** Ordered list of all Whisper-supported language codes and names. */
export const WHISPER_LANGUAGES: readonly SttModelLanguage[] = [
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
 */
export function getWhisperLanguages(): readonly SttModelLanguage[] {
  return WHISPER_LANGUAGES;
}

// ========== SenseVoice ==========
// https://github.com/FunAudioLLM/SenseVoice/blob/1a90d46cb933ef9e213b7d90292b9301b3e20f40/api.py#L22

/** Ordered list of SenseVoice-supported language codes and names. */
export const SENSEVOICE_LANGUAGES: readonly SttModelLanguage[] = [
  { id: 'auto', name: 'auto' },
  { id: 'zh', name: 'chinese' },
  { id: 'en', name: 'english' },
  { id: 'yue', name: 'cantonese' },
  { id: 'ja', name: 'japanese' },
  { id: 'ko', name: 'korean' },
] as const;

/**
 * Returns the list of SenseVoice-supported language codes and display names.
 * Use for modelOptions.senseVoice.language so users only pick valid codes.
 */
export function getSenseVoiceLanguages(): readonly SttModelLanguage[] {
  return SENSEVOICE_LANGUAGES;
}

// ========== Canary ==========
// Used for modelOptions.canary.srcLang and modelOptions.canary.tgtLang.
// sherpa-onnx canary only supports 4 languages as it is the 180m model. The 1b model supports 25 languages.
// https://build.nvidia.com/nvidia/canary-1b-asr/modelcard

/** Canary: en, es, de, fr. */
export const CANARY_LANGUAGES: readonly SttModelLanguage[] = [
  { id: 'en', name: 'english' },
  { id: 'es', name: 'spanish' },
  { id: 'de', name: 'german' },
  { id: 'fr', name: 'french' },
] as const;

/**
 * Returns the list of Canary-supported language codes and display names.
 * Use for modelOptions.canary.srcLang and modelOptions.canary.tgtLang.
 */
export function getCanaryLanguages(): readonly SttModelLanguage[] {
  return CANARY_LANGUAGES;
}

// ========== FunASR Nano ==========
// Ids are the values passed to model.generate(..., language="中文"). Names are English display names.
// https://github.com/FunAudioLLM/Fun-ASR/blob/7dfdb6639e2ba861d3311a8d8c0e3578a8d24122/README.md?plain=1#L99

/** Fun-ASR-Nano-2512: Chinese, English, Japanese. */
export const FUNASR_NANO_LANGUAGES: readonly SttModelLanguage[] = [
  { id: '中文', name: 'chinese' },
  { id: '英文', name: 'english' },
  { id: '日文', name: 'japanese' },
] as const;

/** Fun-ASR-MLT-Nano-2512: multilingual list. */
export const FUNASR_MLT_NANO_LANGUAGES: readonly SttModelLanguage[] = [
  { id: '中文', name: 'chinese' },
  { id: '英文', name: 'english' },
  { id: '粤语', name: 'cantonese' },
  { id: '日文', name: 'japanese' },
  { id: '韩文', name: 'korean' },
  { id: '越南语', name: 'vietnamese' },
  { id: '印尼语', name: 'indonesian' },
  { id: '泰语', name: 'thai' },
  { id: '马来语', name: 'malay' },
  { id: '菲律宾语', name: 'filipino' },
  { id: '阿拉伯语', name: 'arabic' },
  { id: '印地语', name: 'hindi' },
  { id: '保加利亚语', name: 'bulgarian' },
  { id: '克罗地亚语', name: 'croatian' },
  { id: '捷克语', name: 'czech' },
  { id: '丹麦语', name: 'danish' },
  { id: '荷兰语', name: 'dutch' },
  { id: '爱沙尼亚语', name: 'estonian' },
  { id: '芬兰语', name: 'finnish' },
  { id: '希腊语', name: 'greek' },
  { id: '匈牙利语', name: 'hungarian' },
  { id: '爱尔兰语', name: 'irish' },
  { id: '拉脱维亚语', name: 'latvian' },
  { id: '立陶宛语', name: 'lithuanian' },
  { id: '马耳他语', name: 'maltese' },
  { id: '波兰语', name: 'polish' },
  { id: '葡萄牙语', name: 'portuguese' },
  { id: '罗马尼亚语', name: 'romanian' },
  { id: '斯洛伐克语', name: 'slovak' },
  { id: '斯洛文尼亚语', name: 'slovenian' },
  { id: '瑞典语', name: 'swedish' },
] as const;

/**
 * Returns languages for Fun-ASR-Nano-2512 (中文, 英文, 日文).
 * Id is the value for modelOptions.funasrNano.language (e.g. "中文").
 */
export function getFunasrNanoLanguages(): readonly SttModelLanguage[] {
  return FUNASR_NANO_LANGUAGES;
}

/**
 * Returns languages for Fun-ASR-MLT-Nano-2512 (multilingual).
 * Id is the value for modelOptions.funasrNano.language (e.g. "中文").
 */
export function getFunasrMltNanoLanguages(): readonly SttModelLanguage[] {
  return FUNASR_MLT_NANO_LANGUAGES;
}
