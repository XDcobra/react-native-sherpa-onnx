import type {
  SpleeterCustomPathKey,
  UvrCustomPathKey,
} from 'react-native-sherpa-onnx/separation';

export type SeparationCustomPathKey = SpleeterCustomPathKey | UvrCustomPathKey;

/** Human-readable labels for separation custom init path keys (example app UI). */
export const SEPARATION_CUSTOM_PATH_LABELS: Record<
  SeparationCustomPathKey,
  string
> = {
  vocals: 'Vocals stem (.onnx)',
  accompaniment: 'Accompaniment stem (.onnx)',
  model: 'Separation model (.onnx)',
};

export function labelForSeparationCustomPathKey(
  key: SeparationCustomPathKey
): string {
  return SEPARATION_CUSTOM_PATH_LABELS[key] ?? key;
}
