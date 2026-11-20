import type { StreamingSttCustomPathKey } from 'react-native-sherpa-onnx/stt';

const LABELS: Record<StreamingSttCustomPathKey, string> = {
  encoder: 'Encoder (.onnx)',
  decoder: 'Decoder (.onnx)',
  joiner: 'Joiner (.onnx)',
  tokens: 'Tokens (tokens.txt)',
  bpeVocab: 'BPE vocab (optional)',
  model: 'Model (.onnx)',
};

export function labelForStreamingSttCustomPathKey(
  key: StreamingSttCustomPathKey
): string {
  return LABELS[key] ?? key;
}
