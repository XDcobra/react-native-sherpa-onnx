/**
 * Configuration for test audio files.
 * Audio files should be placed in:
 * - Android: android/app/src/main/assets/test_wavs/
 * - iOS: Add to Xcode project as folder reference in test_wavs/
 */

export const TEST_AUDIO_FILES = {
  // English test files (for Zipformer model)
  EN_1: 'test_wavs/0-en.wav',
  EN_2: 'test_wavs/1-en.wav',
  EN_3: 'test_wavs/8k-en.wav',

  // Chinese test files (for Paraformer model)
  ZH_1: 'test_wavs/0-zh.wav',
  ZH_2: 'test_wavs/1-zh.wav',
  ZH_3: 'test_wavs/8k-zh.wav',

  // Mixed language files (for Paraformer model)
  ZH_EN_1: 'test_wavs/2-zh-en.wav',

  // Japanese, Korean, and Yue (Cantonese) test files (for SenseVoice model)
  JA_1: 'test_wavs/ja.wav',
  KO_1: 'test_wavs/ko.wav',
  YUE_1: 'test_wavs/yue.wav',
} as const;

export type AudioFileId =
  (typeof TEST_AUDIO_FILES)[keyof typeof TEST_AUDIO_FILES];

export interface AudioFileInfo {
  id: AudioFileId;
  name: string;
  description: string;
  language: 'en' | 'zh' | 'ja' | 'ko' | 'yue';
}

export const AUDIO_FILES: AudioFileInfo[] = [
  {
    id: TEST_AUDIO_FILES.EN_1,
    name: 'English Sample 1',
    description: 'English audio sample 1',
    language: 'en',
  },
  {
    id: TEST_AUDIO_FILES.EN_2,
    name: 'English Sample 2',
    description: 'English audio sample 2',
    language: 'en',
  },
  {
    id: TEST_AUDIO_FILES.EN_3,
    name: 'English Sample 3',
    description: 'English audio sample 3',
    language: 'en',
  },
  {
    id: TEST_AUDIO_FILES.ZH_1,
    name: '中文样本 1',
    description: 'Chinese audio sample 1',
    language: 'zh',
  },
  {
    id: TEST_AUDIO_FILES.ZH_2,
    name: '中文样本 2',
    description: 'Chinese audio sample 2',
    language: 'zh',
  },
  {
    id: TEST_AUDIO_FILES.ZH_3,
    name: '中文样本 3',
    description: 'Chinese audio sample 3',
    language: 'zh',
  },
  {
    id: TEST_AUDIO_FILES.ZH_EN_1,
    name: '中英混合样本',
    description: 'Chinese-English mixed audio sample',
    language: 'zh', // Paraformer supports both, so we can categorize it as 'zh'
  },
  {
    id: TEST_AUDIO_FILES.JA_1,
    name: '日本語サンプル',
    description: 'Japanese audio sample',
    language: 'ja',
  },
  {
    id: TEST_AUDIO_FILES.KO_1,
    name: '한국어 샘플',
    description: 'Korean audio sample',
    language: 'ko',
  },
  {
    id: TEST_AUDIO_FILES.YUE_1,
    name: '粵語樣本',
    description: 'Yue (Cantonese) audio sample',
    language: 'yue',
  },
];

/**
 * Get audio files compatible with the given model
 * - Zipformer: English files only
 * - Paraformer: All files (English and Chinese) - supports both languages
 * - NeMo CTC: English files only
 * - Whisper: English files only
 * - WeNet CTC: All files (Chinese, English, Cantonese/Yue) - supports multiple languages
 * - SenseVoice: All files (Chinese, English, Japanese, Korean, Yue) - supports multiple languages
 * - FunASR Nano: All files (multi-language support) - supports multiple languages
 */
export function getAudioFilesForModel(modelId: string): AudioFileInfo[] {
  const isParaformer = modelId.includes('paraformer');
  const isZipformer = modelId.includes('zipformer');
  const isNemoCtc = modelId.includes('nemo') && modelId.includes('ctc');
  const isWenetCtc = modelId.includes('wenet') && modelId.includes('ctc');
  const isWhisper = modelId.includes('whisper');
  const isSenseVoice =
    modelId.includes('sense') || modelId.includes('sensevoice');
  const isFunAsrNano = modelId.includes('funasr') && modelId.includes('nano');
  const isEnglish =
    modelId.includes('en') &&
    !isParaformer &&
    !isWenetCtc &&
    !isSenseVoice &&
    !isFunAsrNano;

  // SenseVoice supports all languages including Japanese, Korean, and Yue
  if (isSenseVoice) {
    return AUDIO_FILES;
  }

  // Paraformer, WeNet CTC, and FunASR Nano support multiple languages (but not ja/ko/yue)
  if (isParaformer || isWenetCtc || isFunAsrNano) {
    return AUDIO_FILES.filter(
      (file) => file.language === 'en' || file.language === 'zh'
    );
  }

  // Zipformer, NeMo CTC, and Whisper support only English
  if (isZipformer || isNemoCtc || isWhisper || isEnglish) {
    return AUDIO_FILES.filter((file) => file.language === 'en');
  }

  // Default: return Chinese files (for other models)
  return AUDIO_FILES.filter((file) => file.language === 'zh');
}
