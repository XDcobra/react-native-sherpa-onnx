import type { TtsCustomPathKey } from 'react-native-sherpa-onnx/tts';

/** Human-readable labels for TTS custom init path keys (example app UI). */
export const TTS_CUSTOM_PATH_LABELS: Record<TtsCustomPathKey, string> = {
  ttsModel: 'TTS model (.onnx)',
  tokens: 'Tokens (tokens.txt)',
  lexicon: 'Lexicon (lexicon.txt, optional)',
  dataDir: 'espeak-ng-data directory',
  voices: 'Voices file (e.g. voices.bin)',
  acousticModel: 'Acoustic model (.onnx)',
  vocoder: 'Vocoder (.onnx)',
  encoder: 'Encoder (.onnx)',
  decoder: 'Decoder (.onnx)',
  lmFlow: 'LM flow (.onnx)',
  lmMain: 'LM main (.onnx)',
  textConditioner: 'Text conditioner (.onnx)',
  vocabJson: 'Vocab JSON',
  tokenScoresJson: 'Token scores JSON',
  durationPredictor: 'Duration predictor (.onnx)',
  textEncoder: 'Text encoder (.onnx)',
  vectorEstimator: 'Vector estimator (.onnx)',
  ttsJson: 'TTS config JSON',
  unicodeIndexer: 'Unicode indexer',
  voiceStyle: 'Voice style file',
};

export function labelForTtsCustomPathKey(key: TtsCustomPathKey): string {
  return TTS_CUSTOM_PATH_LABELS[key] ?? key;
}
