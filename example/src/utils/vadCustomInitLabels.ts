import type { VadCustomPathKey } from 'react-native-sherpa-onnx/vad';

/** Human-readable labels for VAD custom init path keys (example app UI). */
export const VAD_CUSTOM_PATH_LABELS: Record<VadCustomPathKey, string> = {
  model: 'VAD model (.onnx)',
};

export function labelForVadCustomPathKey(key: VadCustomPathKey): string {
  return VAD_CUSTOM_PATH_LABELS[key] ?? key;
}
