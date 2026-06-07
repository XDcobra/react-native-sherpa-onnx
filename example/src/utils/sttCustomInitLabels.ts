import type { SttCustomPathKey } from 'react-native-sherpa-onnx/stt';

/** Human-readable labels for custom init path keys (example app UI). */
export const STT_CUSTOM_PATH_LABELS: Record<SttCustomPathKey, string> = {
  encoder: 'Encoder (.onnx)',
  decoder: 'Decoder (.onnx)',
  joiner: 'Joiner (.onnx)',
  tokens: 'Tokens (tokens.txt)',
  bpeVocab: 'BPE vocab (optional)',
  paraformerModel: 'Paraformer model (.onnx)',
  ctcModel: 'CTC model (.onnx)',
  whisperEncoder: 'Whisper encoder (.onnx)',
  whisperDecoder: 'Whisper decoder (.onnx)',
  funasrEncoderAdaptor: 'FunASR encoder adaptor',
  funasrLLM: 'FunASR LLM',
  funasrEmbedding: 'FunASR embedding',
  funasrTokenizer: 'FunASR tokenizer',
  qwen3ConvFrontend: 'Qwen3 conv frontend',
  qwen3Encoder: 'Qwen3 encoder',
  qwen3Decoder: 'Qwen3 decoder',
  qwen3Tokenizer: 'Qwen3 tokenizer',
  cohereEncoder: 'Cohere encoder',
  cohereDecoder: 'Cohere decoder',
  moonshinePreprocessor: 'Moonshine preprocessor',
  moonshineEncoder: 'Moonshine encoder',
  moonshineUncachedDecoder: 'Moonshine uncached decoder',
  moonshineCachedDecoder: 'Moonshine cached decoder',
  moonshineMergedDecoder: 'Moonshine v2 merged decoder',
  fireRedEncoder: 'FireRed encoder',
  fireRedDecoder: 'FireRed decoder',
  canaryEncoder: 'Canary encoder',
  canaryDecoder: 'Canary decoder',
  dolphinModel: 'Dolphin model',
  omnilingualModel: 'Omnilingual model',
  medasrModel: 'MedASR model',
  telespeechCtcModel: 'TeleSpeech CTC model',
};

export function labelForSttCustomPathKey(key: SttCustomPathKey): string {
  return STT_CUSTOM_PATH_LABELS[key] ?? key;
}
