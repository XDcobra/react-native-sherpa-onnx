import type { FileSource } from 'react-native-sherpa-onnx/fileio';
import { fileSourceFromBundledPath } from './utils/fileSourceFromUri';

/**
 * Configuration for test audio files.
 * Audio files should be placed in:
 * - Android: example/android/app/src/main/assets/test_wavs/
 * - iOS: example/ios/sherpa_models/test_wavs/ (copied into the app bundle at build time)
 */

/**
 * Codec round-trip samples for the File I/O example screen.
 * - Android: example/android/app/src/main/assets/test_codec/
 * - iOS: example/ios/sherpa_models/test_codec/ (copied at build time)
 */
export const TEST_CODEC_FILES = {
  wav: 'test_codec/sample.wav',
  mp3: 'test_codec/sample.mp3',
  flac: 'test_codec/sample.flac',
  aac: 'test_codec/sample.aac',
  m4a: 'test_codec/sample.m4a',
  opus: 'test_codec/sample.opus',
  webm: 'test_codec/sample.webm',
  mkv: 'test_codec/sample.mkv',
  ogg: 'test_codec/sample.ogg',
} as const;

export type CodecAssetFormat = keyof typeof TEST_CODEC_FILES;

export const CODEC_ASSET_ENTRIES: {
  format: CodecAssetFormat;
  label: string;
}[] = [
  { format: 'wav', label: 'WAV' },
  { format: 'mp3', label: 'MP3' },
  { format: 'flac', label: 'FLAC' },
  { format: 'm4a', label: 'M4A' },
  { format: 'aac', label: 'AAC' },
  { format: 'opus', label: 'Opus' },
  { format: 'ogg', label: 'OGG' },
  { format: 'webm', label: 'WebM' },
  { format: 'mkv', label: 'MKV' },
];

export function fileSourceFromBundledCodecFormat(
  format: CodecAssetFormat
): FileSource {
  return fileSourceFromBundledPath(TEST_CODEC_FILES[format]);
}

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

  // Multi-speaker test files (dedicated to Diarization and Speaker Identification)
  FOUR_SPEAKERS_ZH: 'test_wavs/0-four-speakers-zh.wav',
  TWO_SPEAKERS_EN_1: 'test_wavs/1-two-speakers-en.wav',
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

/**
 * Dedicated multi-speaker audio recordings for Diarization and Speaker Identification.
 * Kept isolated from single-speaker features (STT, TTS, Enhancement, Offline Pipeline)
 * so they are not accidentally presented for single-speaker tasks.
 */
export const DIARIZATION_AUDIO_FILES: AudioFileInfo[] = [
  {
    id: TEST_AUDIO_FILES.FOUR_SPEAKERS_ZH,
    name: '4 Speakers (Chinese Meeting)',
    description: '4-speaker conversation (56.9s) from sherpa-onnx',
    language: 'zh',
  },
  {
    id: TEST_AUDIO_FILES.TWO_SPEAKERS_EN_1,
    name: '2 Speakers (English Dialogue)',
    description: '2-speaker dialogue (16.0s) from sherpa-onnx',
    language: 'en',
  },
];

/**
 * Keyword Spotting example clips — same shared `AUDIO_FILES` as other features
 * (en / zh / zh-en only). Selecting an entry prefills the Keywords textarea with
 * a `keywords.txt` body tokenized for the default bilingual pack
 * `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` (`phone+ppinyin` via
 * `sherpa-onnx-cli text2token` + pack `en.phone` lexicon).
 *
 * ja / ko / yue clips are omitted here: that pack cannot spot those languages.
 */
export type KwsExampleAudio = AudioFileInfo & {
  /** Ground-truth / SenseVoice transcript used to pick demo phrases */
  transcript: string;
  /** keywords.txt body shown in the textarea when this example is selected */
  keywordsBody: string;
};

const KWS_SHARED_AUDIO_BY_ID = new Map(
  AUDIO_FILES.filter((f) => f.language === 'en' || f.language === 'zh').map(
    (f) => [f.id, f]
  )
);

function kwsExample(
  id: AudioFileId,
  transcript: string,
  keywordsBody: string
): KwsExampleAudio {
  const base = KWS_SHARED_AUDIO_BY_ID.get(id);
  if (!base) {
    throw new Error(`KWS example audio missing from AUDIO_FILES: ${id}`);
  }
  return {
    ...base,
    description: `${base.description} — says: ${transcript}`,
    transcript,
    keywordsBody,
  };
}

export const KWS_AUDIO_FILES: KwsExampleAudio[] = [
  kwsExample(
    TEST_AUDIO_FILES.EN_1,
    'After early nightfall, the yellow lamps would light up here and there the squalid quarter of the brothels.',
    [
      'L AY1 T AH1 P :2.0 #0.25 @LIGHT_UP',
      'Y EH1 L OW0 L AE1 M P S :1.5 #0.25 @YELLOW_LAMPS',
      'N AY1 T F AO2 L :1.5 #0.25 @NIGHTFALL',
    ].join('\n')
  ),
  kwsExample(
    TEST_AUDIO_FILES.EN_2,
    'God, as a direct consequence of the sin which man thus punished, had given her a lovely child … to be finally a blessed soul in heaven.',
    [
      'L AH1 V L IY0 CH AY1 L D :2.0 #0.25 @LOVELY_CHILD',
      'B L EH1 S T S OW1 L :1.5 #0.25 @BLESSED_SOUL',
      'HH EH1 V AH0 N :1.5 #0.25 @HEAVEN',
    ].join('\n')
  ),
  kwsExample(
    TEST_AUDIO_FILES.EN_3,
    'Yet these thoughts affected Hester Prynne less with hope than apprehension.',
    [
      'HH OW1 P :2.0 #0.25 @HOPE',
      'AE2 P R IH0 HH EH1 N SH AH0 N :1.5 #0.25 @APPREHENSION',
      'TH AO1 T S :1.5 #0.25 @THOUGHTS',
    ].join('\n')
  ),
  kwsExample(
    TEST_AUDIO_FILES.ZH_1,
    '对我做了介绍啊，那么我想说的是呢，大家如果对我的研究感兴趣呢嗯。',
    [
      'j iè sh ào :2.0 #0.25 @介绍',
      'y án j iū :1.5 #0.25 @研究',
      'g ǎn x ìng q ù :1.5 #0.25 @感兴趣',
    ].join('\n')
  ),
  kwsExample(
    TEST_AUDIO_FILES.ZH_2,
    '重点呢想谈三个问题。首先呢就是这一轮全球金融动荡的表现。',
    [
      'zh òng d iǎn :2.0 #0.25 @重点',
      'q uán q iú :1.5 #0.25 @全球',
      'j īn r óng :1.5 #0.25 @金融',
      'd òng d àng :1.5 #0.25 @动荡',
    ].join('\n')
  ),
  kwsExample(
    TEST_AUDIO_FILES.ZH_3,
    '深入的分析这一次全球金融动荡背后的根源。',
    [
      'sh ēn r ù :2.0 #0.25 @深入',
      'f ēn x ī :1.5 #0.25 @分析',
      'g ēn y uán :1.5 #0.25 @根源',
    ].join('\n')
  ),
  kwsExample(
    TEST_AUDIO_FILES.ZH_EN_1,
    'yesterday was 星期一，today is Tuesday。明天是星期三。',
    [
      'Y EH1 S T ER0 D EY2 :2.0 #0.25 @YESTERDAY',
      'T AH0 D EY1 :1.5 #0.25 @TODAY',
      'T UW1 Z D IY0 :1.5 #0.25 @TUESDAY',
      'x īng q ī y ī :1.5 #0.25 @星期一',
      'x īng q ī s ān :2.0 #0.25 @星期三',
      'm íng t iān :1.5 #0.25 @明天',
    ].join('\n')
  ),
];
