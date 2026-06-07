import type { StreamingSttCustomPathKey } from 'react-native-sherpa-onnx/stt';

const LABELS: Record<StreamingSttCustomPathKey, string> = {
  encoder: 'Encoder (.onnx)',
  decoder: 'Decoder (.onnx)',
  joiner: 'Joiner (.onnx)',
  tokens: 'Tokens (tokens.txt)',
  model: 'Model (.onnx)',
};

export function labelForStreamingSttCustomPathKey(
  key: StreamingSttCustomPathKey
): string {
  return LABELS[key] ?? key;
}
